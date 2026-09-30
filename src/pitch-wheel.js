// The pitch wheel: how a note's tuning and bend reach a MIDI file.
//
// MIDI has no pitch between two keys. What it has is the wheel, a per-channel
// offset that a synth adds to every note sounding on that channel. So a
// note's `tuning` (a fixed offset) and its `bend` (an offset that moves) are
// both written as wheel moves, and the two are one curve: the tuning is the
// baseline the bend moves around.
//
// Being per channel is the catch. Two notes whose curves overlap on one
// channel cannot both be right, so the later one is written unbent, and
// export-losses says so; an MPE file (one channel per note) has no such
// overlap. Two notes held at the same tuning are fine together: the wheel is
// simply left where it is until the last of them ends.

import { compilePerformanceTrack } from "./format/performance.js";

/** Centre of the 14-bit wheel: zero cents. */
export const WHEEL_CENTRE = 8192;

/**
 * The wheel curves of a track: one per note whose pitch is tuned or moves,
 * in cents from the written pitch, as absolute-time anchors.
 *
 * @param {Array<Object>} notes - JMON notes with numeric `time`
 * @returns {Array<{index:number, anchors:Array<{time:number,value:number}>, start:number, end:number}>}
 *   in order of start
 */
export function pitchWheelCurves(notes) {
  let perf;
  try {
    perf = compilePerformanceTrack({ events: notes });
  } catch (_) {
    return [];
  }
  const curves = new Map();
  for (const m of perf.modulations || []) {
    if (m.type !== "pitch" || !Array.isArray(m.anchors) || m.anchors.length === 0) continue;
    curves.set(m.index, {
      index: m.index,
      anchors: m.anchors.map((a) => ({ time: a.time, value: a.value })),
      start: m.start,
      end: m.end,
    });
  }
  notes.forEach((note, index) => {
    if (!note || note.pitch === null || note.pitch === undefined) return;
    const cents = (Number(note.tuning ?? note.microtuning) || 0) * 100;
    if (!cents) return;
    const curve = curves.get(index);
    if (curve) {
      for (const a of curve.anchors) a.value += cents;
      return;
    }
    const start = Number(note.time) || 0;
    const end = start + Math.max(0, Number(note.duration) || 0);
    curves.set(index, { index, anchors: [{ time: start, value: cents }, { time: end, value: cents }], start, end });
  });
  return [...curves.values()].sort((a, b) => a.start - b.start || a.index - b.index);
}

/** A curve that holds one value throughout. */
function constantValue(curve) {
  const first = curve.anchors[0].value;
  return curve.anchors.every((a) => a.value === first) ? first : null;
}

/**
 * Which curves can be written on their channel, and which overlap an earlier
 * one there and are left out. Two curves may overlap when both hold the same
 * value: the wheel stays put.
 *
 * @param {Array} curves - from `pitchWheelCurves`
 * @param {(index:number)=>number} channelOf - the channel a note is written on
 * @returns {{written:Array, dropped:Array}} each curve with its `channel`
 */
export function pitchWheelPlan(curves, channelOf) {
  const written = [];
  const dropped = [];
  for (const curve of curves) {
    const channel = channelOf(curve.index);
    const sounding = written.filter((w) => w.channel === channel && w.end > curve.start + 1e-9);
    const held = constantValue(curve);
    const agree = sounding.every((w) => held !== null && constantValue(w) === held);
    if (agree) written.push({ ...curve, channel });
    else dropped.push({ ...curve, channel });
  }
  return { written, dropped };
}

/** The 14-bit wheel value for an offset in cents, within a bend range in semitones. */
export function wheelValue(cents, rangeSemitones) {
  const span = Math.max(0.01, rangeSemitones) * 100;
  const v = WHEEL_CENTRE + Math.round((cents / span) * (WHEEL_CENTRE - 1));
  return Math.max(0, Math.min(16383, v));
}

/**
 * The bend range the curves need, in semitones: the widest offset rounded
 * up, at least 2 (a controller's usual range) and at most 24.
 */
export function wheelRangeFor(curves) {
  const maxCents = Math.max(0, ...curves.flatMap((c) => c.anchors.map((a) => Math.abs(a.value))));
  return Math.min(24, Math.max(2, Math.ceil(maxCents / 100)));
}

/**
 * The MIDI events that draw the written curves: for each channel, a pitch
 * bend sensitivity (RPN 0/0) unless told not to, then each curve as a sweep
 * of wheel moves, recentred when the last note bending that channel ends.
 *
 * @param {Array} written - from `pitchWheelPlan`
 * @param {number} ticksPerBeat
 * @param {Object} [options]
 * @param {number} [options.range] - bend range in semitones; defaults to what the curves need
 * @param {boolean} [options.sensitivity=true] - write the RPN that sets the range
 * @returns {Array<{tick:number, sortOrder:number, bytes:number[]}>}
 */
export function pitchWheelEvents(written, ticksPerBeat, options = {}) {
  if (written.length === 0) return [];
  const range = options.range ?? wheelRangeFor(written);
  const events = [];

  if (options.sensitivity !== false) {
    // RPN 0,0 = pitch bend sensitivity, in semitones (MSB) + cents (LSB),
    // then deselect the RPN so later CCs can't change it accidentally.
    const rpn = [[101, 0], [100, 0], [6, range], [38, 0], [101, 127], [100, 127]];
    for (const channel of [...new Set(written.map((w) => w.channel))]) {
      rpn.forEach(([cc, value]) => {
        events.push({ tick: 0, sortOrder: -1, bytes: [0xb0 | channel, cc, value] });
      });
    }
  }

  const push = (channel, tick, value, sortOrder) => {
    events.push({ tick, sortOrder, bytes: [0xe0 | channel, value & 0x7f, (value >> 7) & 0x7f] });
  };
  // Sample each linear segment finely enough to sound continuous.
  const stepTicks = Math.max(1, Math.round(ticksPerBeat / 16));

  for (const curve of written) {
    const { channel, anchors } = curve;
    // Initial value lands between note-off (0) and note-on (1) at the same
    // tick so the wheel is set before the note sounds.
    push(channel, Math.round(anchors[0].time * ticksPerBeat), wheelValue(anchors[0].value, range), 0.5);

    for (let k = 1; k < anchors.length; k++) {
      const a = anchors[k - 1];
      const b = anchors[k];
      const aTick = Math.round(a.time * ticksPerBeat);
      const bTick = Math.round(b.time * ticksPerBeat);
      let lastValue = wheelValue(a.value, range);
      for (let tick = aTick + stepTicks; tick < bTick; tick += stepTicks) {
        const frac = (tick - aTick) / (bTick - aTick);
        const value = wheelValue(a.value + (b.value - a.value) * frac, range);
        if (value === lastValue) continue;
        push(channel, tick, value, 2);
        lastValue = value;
      }
      // The arrival value lands on the note boundary, where the recentre
      // (0.25) also sits. Order it just ahead of the recentre rather than at
      // 2, or the wheel is left off-centre for whatever follows.
      const isArrival = k === anchors.length - 1;
      const endValue = wheelValue(b.value, range);
      if (endValue !== lastValue || bTick === aTick) {
        push(channel, bTick, endValue, isArrival ? 0.2 : 2);
      }
    }

    // Recentre so the next note starts clean, unless another note is still
    // holding the wheel on this channel. sortOrder 0.25 keeps the reset ahead
    // of a following curve's initial value at the same tick.
    const last = anchors[anchors.length - 1];
    const stillHeld = written.some((w) => w !== curve && w.channel === channel && w.start < curve.end - 1e-9 && w.end > curve.end + 1e-9);
    if (!stillHeld && wheelValue(last.value, range) !== WHEEL_CENTRE) {
      push(channel, Math.round(curve.end * ticksPerBeat), WHEEL_CENTRE, 0.25);
    }
  }

  return events;
}
