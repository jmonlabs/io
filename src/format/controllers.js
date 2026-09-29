/**
 * A track's controller moves: every control change, pitch bend and channel
 * pressure the piece asks of the track's instrument, wherever it says them.
 *
 * JMON has three places for them:
 *
 *   - `track.cc`: steps, `{ time, controller, value }`, time in quarter notes
 *     from the start of the piece, value 0..1;
 *   - `note.modulations`: moves inside one note, `{ type: "cc" | "pitchBend" |
 *     "aftertouch", controller, value, time }`, time from the note's start
 *     (a note value such as "8n", "bars:beats:ticks", or seconds), value in
 *     MIDI units (0..127, pitch bend -8192..8192);
 *   - automation lanes whose target is `midi.ccN`, on the piece
 *     (`automation.global`, `automation.tracks[label]`) or on the track
 *     (`track.automation`), drawn between anchor points, value 0..1. A lane
 *     that `converterHints.tone` maps onto an audio parameter is that
 *     parameter's business, not the instrument's, and is left out.
 *
 * All three come out as one list in one set of units, which the MIDI writer
 * writes and a player sends to the instrument.
 */

import { automationChannels, parseAutomationTarget, readBeatsPerBar, readTime, resolveCcHint } from "./timeline.js";

/** Quarter notes between two points of a lane drawn as controller steps. */
const LANE_STEP = 1 / 32;

/**
 * @typedef {Object} ControllerEvent
 * @property {number} time - quarter notes from the start of the piece
 * @property {"cc"|"pitchBend"|"aftertouch"} type
 * @property {number} [controller] - for "cc"
 * @property {number} value - 0..1 for "cc" and "aftertouch", -1..1 for "pitchBend"
 * @property {number} [channel] - a `track.cc` entry's own channel, if it names one
 */

/**
 * Every controller move of a track, in time order.
 *
 * @param {Object} track
 * @param {Object} [piece] - for the tempo, the metre and the automation
 * @param {number} [trackIndex] - identifies the track in `automation.tracks`
 *   when it has no label
 * @returns {Array<ControllerEvent>}
 */
export function controllerEvents(track, piece = {}, trackIndex = null) {
  const events = [
    ...fromTrackCc(track),
    ...fromNoteModulations(track, piece),
    ...fromAutomation(track, piece, trackIndex),
  ];
  // Stable: moves at the same instant keep the order they were written in.
  return events
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.time - b.event.time || a.order - b.order)
    .map(({ event }) => event);
}

function fromTrackCc(track) {
  const events = [];
  for (const c of Array.isArray(track?.cc) ? track.cc : []) {
    const controller = Number(c?.controller ?? c?.cc);
    const value = Number(c?.value);
    if (!Number.isFinite(controller) || !Number.isFinite(value)) continue;
    const event = { time: Math.max(0, Number(c.time) || 0), type: "cc", controller, value: clamp(value, 0, 1) };
    if (Number.isFinite(Number(c.channel))) event.channel = Number(c.channel);
    events.push(event);
  }
  return events;
}

function fromNoteModulations(track, piece) {
  const tempo = piece.tempo || piece.bpm || 120;
  const beatsPerBar = readBeatsPerBar(piece);
  const events = [];
  for (const note of Array.isArray(track?.notes) ? track.notes : []) {
    if (!Array.isArray(note?.modulations) || note.modulations.length === 0) continue;
    const start = Number(note.time) || 0;
    for (const m of note.modulations) {
      const time = start + noteRelativeBeats(m?.time, tempo, beatsPerBar);
      const value = Number(m?.value);
      if (!Number.isFinite(value)) continue;
      if (m.type === "cc" && Number.isFinite(Number(m.controller))) {
        events.push({ time, type: "cc", controller: Number(m.controller), value: clamp(value / 127, 0, 1) });
      } else if (m.type === "pitchBend") {
        events.push({ time, type: "pitchBend", value: clamp(value / 8192, -1, 1) });
      } else if (m.type === "aftertouch") {
        events.push({ time, type: "aftertouch", value: clamp(value / 127, 0, 1) });
      }
    }
  }
  return events;
}

/**
 * A time inside a note, as quarter notes: a note value ("4n" a quarter, "8n"
 * an eighth, "8t" an eighth triplet, "4n." a dotted quarter),
 * "bars:beats:ticks", or a number, which the schema defines as seconds.
 */
export function noteRelativeBeats(value, tempo = 120, beatsPerBar = 4) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, value * tempo / 60) : 0;
  if (typeof value !== "string") return 0;
  const noteValue = /^(\d+)([nt])(\.?)$/.exec(value.trim());
  if (noteValue) {
    const [, division, kind, dot] = noteValue;
    const beats = 4 / Number(division);
    return beats * (kind === "t" ? 2 / 3 : 1) * (dot ? 1.5 : 1);
  }
  return Math.max(0, readTime(value, beatsPerBar));
}

function fromAutomation(track, piece, trackIndex) {
  const label = track?.label;
  const lanes = automationChannels(piece).filter((lane) =>
    lane.scope === "global"
    || (label !== undefined && lane.trackId === label)
    || (trackIndex !== null && String(lane.trackId) === String(trackIndex)));

  const events = [];
  for (const lane of lanes) {
    const target = parseAutomationTarget(lane.target);
    if (target.kind !== "midi" || !Number.isFinite(target.cc)) continue;
    if (resolveCcHint(target.cc, piece)) continue;
    let last = null;
    const step = (time, value, always = false) => {
      const v = clamp(value, 0, 1);
      if (!always && v === last) return;
      events.push({ time, type: "cc", controller: target.cc, value: v });
      last = v;
    };
    const { points } = lane;
    step(points[0].time, points[0].value, true);
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      // A lane is drawn straight between its points; a controller only takes
      // steps, so the line is walked in small ones.
      for (let t = a.time + LANE_STEP; t < b.time - 1e-9; t += LANE_STEP) {
        step(t, a.value + (b.value - a.value) * ((t - a.time) / (b.time - a.time)));
      }
      step(b.time, b.value);
    }
  }
  return events;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}
