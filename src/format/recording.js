/**
 * A take on a keyboard, as JMON.
 *
 * What a player hears from a MIDI keyboard, stamped with its place in the
 * piece, becomes what a track says:
 *
 *   - the keys become notes;
 *   - the knobs and faders become the track's controller steps (`track.cc`,
 *     time in quarter notes, value 0..1);
 *   - the pitch bend becomes moves inside the notes it bends
 *     (`note.modulations`, time in seconds from the note's start, value
 *     -8192..8192, as the schema says).
 *
 * So a take plays back the way it was played, live, rendered or in a MIDI
 * file: io's `controllerEvents` reads both places.
 */

/**
 * @typedef {Object} KeyboardEvent
 * @property {number} time - quarter notes
 * @property {"on"|"off"|"cc"|"pitchBend"} type
 * @property {number} [pitch] - MIDI note, for "on" and "off"
 * @property {number} [velocity] - 0..1, for "on"
 * @property {number} [controller] - for "cc"
 * @property {number} [value] - 0..1 for "cc", -1..1 for "pitchBend"
 */

/**
 * The notes and controller steps of a take.
 *
 * @param {Array<KeyboardEvent>} events
 * @param {Object} [options]
 * @param {number} [options.grid=0] - quarter notes; starts and lengths snap to it (0: as played)
 * @param {number} [options.loop=0] - quarter notes; a take over a loop folds every time into it,
 *   so the passes stack (0: one straight take, from time 0)
 * @param {number} [options.tempo=120] - for the bend's times, which are in seconds
 * @returns {{ notes: Array<Object>, cc: Array<Object> }}
 */
export function recordedTrack(events, { grid = 0, loop = 0, tempo = 120 } = {}) {
  const sorted = [...(events ?? [])].sort((a, b) => a.time - b.time);
  const last = sorted.length ? sorted[sorted.length - 1].time : 0;
  const place = (time, snap = true) => {
    let t = snap && grid > 0 ? Math.round(time / grid) * grid : time;
    if (loop > 0) t = ((t % loop) + loop) % loop;
    else t = Math.max(0, t);
    return round(t);
  };

  // The keys: a release ends the oldest note still held at its pitch. A note
  // still held when the take stops lasts until the last event.
  const held = new Map();
  const played = [];
  let bend = 0;
  for (const event of sorted) {
    if (event.type === "on") {
      const note = { pitch: event.pitch, start: event.time, end: null, velocity: event.velocity ?? 0.8, bends: [] };
      if (bend !== 0) note.bends.push({ time: event.time, value: bend });
      if (!held.has(event.pitch)) held.set(event.pitch, []);
      held.get(event.pitch).push(note);
      played.push(note);
    } else if (event.type === "off") {
      const note = held.get(event.pitch)?.shift();
      if (note) note.end = event.time;
    } else if (event.type === "pitchBend") {
      bend = event.value;
      for (const notes of held.values()) for (const note of notes) note.bends.push({ time: event.time, value: bend });
    }
  }

  const notes = played.map((p) => {
    const time = place(p.start);
    let duration = (p.end ?? last) - p.start;
    if (grid > 0) duration = Math.max(grid, Math.round(duration / grid) * grid);
    if (loop > 0) duration = Math.min(duration, loop - time); // a note does not run past the loop
    const note = { pitch: p.pitch, time, duration: round(Math.max(duration, 0.01)), velocity: round(p.velocity, 2) };
    if (p.bends.length) {
      note.modulations = p.bends.map((b) => ({
        type: "pitchBend",
        time: round(Math.max(0, b.time - p.start) * 60 / tempo),
        value: Math.round(Math.max(-1, Math.min(1, b.value)) * 8192),
      }));
    }
    return note;
  }).sort((a, b) => a.time - b.time || a.pitch - b.pitch);

  // The knobs: one step per move, without the repeats.
  const cc = [];
  const lastValue = new Map();
  for (const event of sorted) {
    if (event.type !== "cc") continue;
    const value = round(Math.max(0, Math.min(1, event.value)));
    if (lastValue.get(event.controller) === value) continue;
    lastValue.set(event.controller, value);
    cc.push({ time: place(event.time, false), controller: event.controller, value });
  }
  cc.sort((a, b) => a.time - b.time);

  return { notes, cc };
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
