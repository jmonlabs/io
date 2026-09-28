// MPE: one channel per note, so a note can carry its own pitch bend.
//
// `microtuning` is a per-note offset in semitones, and a Standard MIDI File has
// no message for it. A channel's pitch wheel moves every note on that channel,
// so in polyphony the only correct answer is a channel per note — which is what
// MPE is: a zone of member channels, one per note, with the master channel
// configuring the zone.
//
// The cost is channels, and the limit is hard. If more notes sound at once than
// there are member channels, this throws rather than quietly putting two notes
// on one channel, because a wrong tuning is worse than no file.

/** De-facto MPE layout: member channels 1-14, master 15, channel 10 for drums. */
export const MPE_DEFAULTS = {
  // 0-indexed. 9 is the GM drum channel and is left out so a piece with both
  // drums and tuned notes does not put them in the same zone.
  members: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14],
  master: 15,
  // Pitch-bend sensitivity in semitones, sent as RPN 0/0. 48 is MPE's usual
  // upper bound; ±2 is a 9MPE-like controller's.
  bendRange: 48,
};

/** Centre of a 14-bit pitch bend, which is zero semitones. */
const BEND_CENTRE = 8192;

/**
 * The 14-bit pitch bend value for an offset in cents, within a sensitivity.
 *
 * @param {number} cents
 * @param {number} rangeSemitones
 * @returns {number} 0..16383, 8192 at zero
 */
export function bendValueFor(cents, rangeSemitones) {
  const span = Math.max(0.01, rangeSemitones) * 100;
  const v = BEND_CENTRE + Math.round((cents / span) * (BEND_CENTRE - 1));
  return Math.max(0, Math.min(16383, v));
}

/**
 * Assign a channel to every note, and say which channel each gets.
 *
 * Greedy by start time, earliest-ending note first when there is a choice, with
 * a channel reusable as soon as every note on it has finished. That is enough
 * for real material: it only fails when more notes genuinely sound at once than
 * there are member channels, which is the case worth refusing.
 *
 * @param {Array<Object>} notes - notes with `time` and `duration` in beats
 * @param {Object} [options] - `MPE_DEFAULTS` merged over
 * @returns {Array<{channel:number, startTick:number, endTick:number}>} per note
 * @throws {Error} when the polyphony exceeds the member channels
 */
export function assignMpeChannels(notes, options = {}) {
  const config = { ...MPE_DEFAULTS, ...options };
  const members = config.members.filter((c) => c >= 0 && c <= 15);
  if (members.length === 0) throw new Error('mpe: no member channels available');
  const ticksPerBeat = config.ticksPerBeat ?? 480;
  const toTicks = (beats) => Math.round((beats || 0) * ticksPerBeat);

  // Only notes that actually sound. A rest has no pitch and no channel to want.
  const sounding = [];
  notes.forEach((note, index) => {
    if (note.pitch === null || note.pitch === undefined) return;
    const start = toTicks(note.time);
    // At least one tick, so a zero-length note still occupies its channel.
    const end = Math.max(start + 1, toTicks((note.time || 0) + (note.duration || 0)));
    sounding.push({ index, start, end });
  });
  sounding.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.index - b.index));

  /** @type {Array<{freeAt:number, note:Object|null}>} */
  const channels = members.map((c) => ({ channel: c, freeAt: -1, note: null }));
  const assigned = new Map();

  for (const note of sounding) {
    // Reuse a channel whose note has finished; a note starting exactly as
    // another ends still overlaps at that tick, so the test is `<=`.
    let slot = channels.find((c) => c.freeAt <= note.start);
    if (!slot) {
      const soonest = channels.reduce((a, b) => (a.freeAt <= b.freeAt ? a : b));
      const nextFree = Math.min(...channels.map((c) => c.freeAt));
      if (nextFree > note.start) {
        throw new Error(
          `mpe: more notes sound at once than there are member channels ` +
          `(${channels.length}). MIDI has 16 channels and no more, so the ` +
          `ceiling is ${members.length}; thin the texture, or export without ` +
          `mpe — two notes on one channel cannot both be detuned.`
        );
      }
      slot = soonest;
    }
    slot.freeAt = note.end;
    assigned.set(note.index, slot.channel);
  }

  void toTicks;
  return sounding.map((n) => ({ index: n.index, startTick: n.start, endTick: n.end, channel: assigned.get(n.index) ?? members[0] }));
}

/**
 * The note-on/off and bend events for one track, one channel per note.
 *
 * The bend is set before the note sounds and returned to centre when it stops,
 * so the next note to take that channel starts centred.
 *
 * @param {Array<Object>} notes
 * @param {Object} config - `MPE_DEFAULTS` merged over, plus `ticksPerBeat`
 * @returns {{events:Array, channelsUsed:Array<number>}}
 */
export function buildMpeNoteEvents(notes, config) {
  const { master, bendRange, ticksPerBeat = 480 } = config;
  const events = [];
  const plan = assignMpeChannels(notes, { ...config, ticksPerBeat });
  const used = [...new Set(plan.map((p) => p.channel))].sort((a, b) => a - b);

  // RPN 0, 0 = pitch bend sensitivity: semitones (MSB) and cents (LSB). Sent
  // per member channel, because a Standard MIDI File has no way to say "these
  // channels form a zone" — the receiving synth has to already be in MPE mode.
  for (const ch of used) {
    if (ch === master) continue;
    for (const [cc, value] of [[101, 0], [100, 0], [6, bendRange], [38, 0], [101, 127], [100, 127]]) {
      events.push({ tick: 0, sortOrder: -1, bytes: [0xb0 | ch, cc, value] });
    }
  }

  for (const { index, startTick, endTick, channel } of plan) {
    const note = notes[index];
    const cents = (Number(note.microtuning) || 0) * 100;
    const value = bendValueFor(cents, bendRange);
    const lo = value & 0x7f;
    const hi = (value >> 7) & 0x7f;

    if (cents !== 0) {
      // Before the note-on, and after the note-off of whatever used this
      // channel before it, which sortOrder 0.5 arranges.
      events.push({ tick: startTick, sortOrder: 0.5, bytes: [0xe0 | channel, lo, hi] });
    }
    const velocity = Math.max(1, Math.min(127, Math.round((note.velocity ?? 0.8) * 127)));
    for (const p of Array.isArray(note.pitch) ? note.pitch : [note.pitch]) {
      if (typeof p !== 'number') continue;
      events.push({ tick: startTick, sortOrder: 1, bytes: [0x90 | channel, p, velocity] });
      events.push({ tick: endTick, sortOrder: 0, bytes: [0x80 | channel, p, 0] });
    }
    if (cents !== 0) {
      // Back to centre, so the next note on this channel is not still bent.
      events.push({ tick: endTick, sortOrder: 0.1, bytes: [0xe0 | channel, BEND_CENTRE & 0x7f, (BEND_CENTRE >> 7) & 0x7f] });
    }
  }

  return { events, channelsUsed: used };
}
