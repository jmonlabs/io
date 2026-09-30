/* jmon-to-midi.js - Convert JMON format to Standard MIDI File (no external deps) */
import { compilePerformanceTrack as compileEvents } from "./format/performance.js";
import { buildMpeNoteEvents, MPE_DEFAULTS } from "./midi-mpe.js";
import { pitchWheelCurves, pitchWheelEvents, pitchWheelPlan } from "./pitch-wheel.js";
import {
    tempoSegments,
    timeSignatureSegments,
    keySignatureSegments,
    automationChannels,
    parseAutomationTarget,
} from "./format/timeline.js";
import { controllerEvents } from "./format/controllers.js";

// --- Built-in MIDI binary encoder ---

function writeVarLen(value) {
    const bytes = [];
    bytes.push(value & 0x7f);
    value >>= 7;
    while (value > 0) {
        bytes.push((value & 0x7f) | 0x80);
        value >>= 7;
    }
    return bytes.reverse();
}

function writeUint16(value) {
    return [(value >> 8) & 0xff, value & 0xff];
}

function writeUint32(value) {
    return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function writeString(str) {
    return Array.from(str, c => c.charCodeAt(0));
}

function encodeTrack(events) {
    const data = [];
    let lastTick = 0;

    // Sort events by tick, then by type (note-off before note-on at same tick)
    events.sort((a, b) => a.tick - b.tick || a.sortOrder - b.sortOrder);

    for (const evt of events) {
        const delta = evt.tick - lastTick;
        data.push(...writeVarLen(delta));
        data.push(...evt.bytes);
        lastTick = evt.tick;
    }

    // End of track
    data.push(0x00, 0xff, 0x2f, 0x00);
    return data;
}

/**
 * The modulations compiled for a track's notes, grouped by note index.
 *
 * `compilePerformanceTrack` returns `modulations` carrying an `index` into
 * the notes it was given, so the note loop and the modulation list can be
 * walked together.
 *
 * @param {Array} notes
 * @param {number} [tempo=120]
 * @returns {Map<number, Array>} note index -> that note's modulations
 */
function modulationsByNote(notes, tempo = 120) {
  const perIndex = new Map();
  let modulations = [];
  try {
    modulations = compileEvents({ notes }, { tempo }).modulations || [];
  } catch (_) {
    return perIndex;
  }
  for (const m of modulations) {
    if (m.index === undefined) continue;
    if (!perIndex.has(m.index)) perIndex.set(m.index, []);
    perIndex.get(m.index).push(m);
  }
  return perIndex;
}

/** A duration as a finite, non-negative number of beats. */
function toBeats(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Note length in beats, with every `durationScale` applied.
 *
 * Scales compose, so marcato + staccato is shorter than either. The caller
 * floors the result at one tick: a note that rounded to zero length would be a
 * note-on with no note-off, which a DAW plays as a stuck key.
 *
 * @param {Object} note
 * @param {Array} modulations
 * @returns {number} duration in beats
 */
function applyDurationScale(note, modulations) {
  let duration = toBeats(note.duration);
  for (const m of modulations) {
    if (m.type !== "durationScale") continue;
    const factor = Number(m.factor);
    if (Number.isFinite(factor) && factor > 0) duration *= factor;
  }
  return duration;
}

/**
 * Note velocity in 0..1, with every `velocityBoost` applied.
 *
 * @param {Object} note
 * @param {Array} modulations
 * @returns {number}
 */
function applyVelocityBoost(note, modulations) {
  let velocity = note.velocity;
  if (typeof velocity !== "number" || !Number.isFinite(velocity)) velocity = 0.8;
  for (const m of modulations) {
    if (m.type !== "velocityBoost") continue;
    const boost = Number(m.amountBoost);
    if (Number.isFinite(boost)) velocity += boost;
  }
  return Math.max(0, Math.min(1, velocity));
}

/**
 * CC 11 (expression) for the `amplitude` modulations.
 *
 * CC 11 is the channel's expression fader: a proportion of the channel volume
 * that a synth applies to itself, on top of each note's velocity. CC 7 is patch
 * volume on most instruments, which is not what a swell means. A DAW that maps
 * CC 11 onto a VST's expression gets the curve, and one that ignores it still
 * plays the notes.
 *
 * An amplitude envelope is already a proportion of the note's velocity, so it
 * maps straight onto the fader, sampled every 1/32 beat between its anchors: a
 * synth jumps from one controller value to the next, so anchors alone would be
 * steps. A rise from silence at the start is left to the instrument's own
 * attack (see below). Other amplitude modulations (crescendo, diminuendo) set the fader to
 * the note's level at its onset.
 *
 * The fader is one per channel, so notes that touch or overlap share it. A
 * note's curve stops where the next note on the channel begins, which takes
 * the fader over; and a note gives the fader back at rest (127) when it ends
 * only if nothing else is sounding then, so that the note already playing is
 * not silenced. A note with no amplitude modulation on a channel that has some
 * starts at rest, rather than inheriting its neighbour's swell.
 *
 * @param {Array} notes
 * @param {number} channel
 * @param {number} ticksPerBeat
 * @returns {Array} MIDI events
 */
function buildExpressionEvents(notes, channel, ticksPerBeat) {
  const perIndex = modulationsByNote(notes);
  const events = [];
  const cc = (beat, value) => events.push({
    tick: Math.round(beat * ticksPerBeat),
    sortOrder: 0.5, // after the note-offs of that tick, before its note-ons
    bytes: [0xb0 | channel, 11, Math.max(0, Math.min(127, Math.round(value)))],
  });

  const spans = notes
    .map((note, index) => ({ index, start: Number(note.time) || 0, end: (Number(note.time) || 0) + toBeats(note.duration) }))
    .filter(({ index }) => notes[index].pitch !== null && notes[index].pitch !== undefined);
  const amplitudeOf = (index) => (perIndex.get(index) || []).filter((m) => m.type === "amplitude");
  if (!spans.some(({ index }) => amplitudeOf(index).length > 0)) return events;

  for (const { index, start, end } of spans) {
    const amplitude = amplitudeOf(index);
    const envelope = amplitude.find((m) => Array.isArray(m.anchors) && m.anchors.length > 0);
    // The next note on the channel takes the fader over from its onset.
    const next = Math.min(end, ...spans.filter((o) => o.start > start && o.start < end).map((o) => o.start));

    if (envelope) {
      let anchors = envelope.anchors.map((a) => ({ time: Number(a.time), value: Math.max(0, Math.min(1, Number(a.value))) }));
      // A curve that rises from silence is the note's attack, which the synth's
      // instrument already gives it. On a shared fader it would also mute the
      // end of the note before, so the curve holds its first level from the
      // onset instead.
      if (anchors.length > 1 && anchors[0].value === 0) {
        anchors = [{ time: start, value: anchors[1].value }, ...anchors.slice(1)];
      }
      const levelAt = (t) => {
        if (t <= anchors[0].time) return anchors[0].value;
        for (let k = 1; k < anchors.length; k++) {
          const a = anchors[k - 1];
          const b = anchors[k];
          if (t <= b.time) return a.value + (b.value - a.value) * ((t - a.time) / (b.time - a.time || 1));
        }
        return anchors.at(-1).value;
      };
      let last = -1;
      for (let t = start; t < next; t += 1 / 32) {
        const value = Math.round(levelAt(t) * 127);
        if (value !== last) cc(t, value);
        last = value;
      }
    } else if (amplitude.length > 0) {
      cc(start, applyVelocityBoost(notes[index], perIndex.get(index) || []) * 127);
    } else {
      cc(start, 127);
    }

    // Back at rest when the note ends, unless another note is still sounding
    // or starts right then (it sets the fader itself).
    const busy = spans.some((o) => o.index !== index && o.start <= end && o.end > end);
    if (!busy && next === end) cc(end, 127);
  }
  return events;
}

/**
 * Render a track's controller moves (see format/controllers.js) as MIDI
 * events: control changes, pitch bends and channel pressure.
 *
 * They are steps, not spans. A controller is told a value and holds it until
 * told otherwise, so there is no duration to write and nothing to release —
 * the same reason a program change is an instant.
 *
 * A `track.cc` entry's own `channel` overrides the track's, which matters
 * under MPE where the track's channel is the master zone and the notes go to
 * member channels.
 *
 * @param {Array<import("./format/controllers.js").ControllerEvent>} moves
 * @param {number} channel
 * @param {number} ticksPerBeat
 * @returns {Array<{tick:number, sortOrder:number, bytes:number[]}>}
 */
function buildControlEvents(moves, channel, ticksPerBeat) {
  return moves.map((move) => {
    // Clamped, not masked: a channel past 15 masked with 0x0f wraps to a low
    // channel, which is a control change arriving somewhere nobody asked for.
    // Clamping lands on the last channel instead, which is at least adjacent.
    const ch = Number.isFinite(move.channel) ? Math.max(0, Math.min(15, move.channel | 0)) : channel;
    let bytes;
    if (move.type === "pitchBend") {
      const wheel = Math.max(0, Math.min(16383, Math.round(8192 + move.value * 8191)));
      bytes = [0xe0 | ch, wheel & 0x7f, wheel >> 7];
    } else if (move.type === "aftertouch") {
      bytes = [0xd0 | ch, Math.round(move.value * 127)];
    } else {
      bytes = [0xb0 | ch, move.controller & 0x7f, Math.round(move.value * 127)];
    }
    // Before a note-on on the same tick, so the controller is already set.
    return { tick: Math.round(toBeats(move.time) * ticksPerBeat), sortOrder: -1, bytes };
  });
}

function buildMidiFile(piece, options = {}) {
    const bpm = piece.tempo || piece.bpm || 120;
    const ticksPerBeat = 480;
    // `mpe` is opt-in: a file with one channel per note is wrong for a synth
    // that is not in MPE mode, and wrong for any GM instrument. Pass it when the
    // destination is an MPE one and tuned or bent notes sound together.
    const mpeConfig = typeof options.mpe === "object" && options.mpe !== null ? options.mpe : null;
    const mpe = options.mpe === true || mpeConfig !== null;
    const masterChannel = (mpeConfig && mpeConfig.master) ?? MPE_DEFAULTS.master;
    const rawTracks = piece.tracks || [];
    const tracksArray = Array.isArray(rawTracks)
        ? rawTracks
        : (rawTracks && typeof rawTracks === 'object' ? Object.values(rawTracks) : []);

    const trackChunks = [];

    // Track 0: tempo track. One set-tempo meta event per segment of the
    // piece's tempoMap, so a piece that changes tempo exports as one —
    // it used to flatten to a single rate at tick 0. Segments come from the
    // same helper the players integrate, so the file agrees with playback.
    // With no tempoMap there is exactly one segment and the output is
    // unchanged.
    // A tempo *ramp* — automation targeting `tempo` — has no MIDI message of
    // its own, so it is approximated as a staircase of set-tempo events.
    // Built first because a ramp anchor is the more specific instruction and
    // wins at a tick the tempoMap also names: that is the order the players
    // schedule them in, and the file has to agree with what you hear.
    const tempoEvents = buildTempoRampEvents(piece, ticksPerBeat);
    const rampTicks = new Set(tempoEvents.map(event => event.tick));

    for (const segment of tempoSegments(piece)) {
        const tick = Math.round(segment.time * ticksPerBeat);
        if (rampTicks.has(tick)) continue;
        const microsecondsPerBeat = Math.round(60000000 / segment.tempo);
        tempoEvents.push({
            tick,
            sortOrder: -1,
            bytes: [0xff, 0x51, 0x03,
                (microsecondsPerBeat >> 16) & 0xff,
                (microsecondsPerBeat >> 8) & 0xff,
                microsecondsPerBeat & 0xff]
        });
    }

    // Time signature (0x58). The writer used to emit none, so an exported
    // piece opened in 4/4 whatever its metre — while the importer read the
    // event back, making the round trip lossy in one direction only.
    for (const segment of timeSignatureSegments(piece)) {
        tempoEvents.push({
            tick: Math.round(segment.time * ticksPerBeat),
            sortOrder: -3,
            bytes: [0xff, 0x58, 0x04,
                segment.numerator,
                Math.round(Math.log2(segment.denominator)),
                24,  // MIDI clocks per metronome click
                8]   // 32nd notes per quarter note
        });
    }

    // Key signature (0x59). `sf` is signed: negative counts flats.
    for (const segment of keySignatureSegments(piece)) {
        tempoEvents.push({
            tick: Math.round(segment.time * ticksPerBeat),
            sortOrder: -3,
            bytes: [0xff, 0x59, 0x02, segment.sharps & 0xff, segment.minor ? 1 : 0]
        });
    }

    // Title
    const title = piece.title || piece.metadata?.title || '';
    if (title) {
        const titleBytes = writeString(title);
        tempoEvents.push({
            tick: 0,
            sortOrder: -4,
            bytes: [0xff, 0x03, ...writeVarLen(titleBytes.length), ...titleBytes]
        });
    }

    trackChunks.push(encodeTrack(tempoEvents));

    // Channel assignment: respect track.channel (or track.midiChannel), else
    // auto-assign sequentially, skipping channel 9 (drums). Accept 1-indexed
    // `channel: 10` as the conventional GM drum channel and normalize to 9.
    let autoChannel = 0;
    const resolveChannel = (track) => {
        const raw = track.channel ?? track.midiChannel;
        if (typeof raw === 'number') {
            if (raw === 10) return 9;           // GM 1-indexed drum channel
            if (raw >= 0 && raw <= 15) return raw;
        }
        if (autoChannel === 9) autoChannel++;   // skip drums slot
        const c = autoChannel;
        autoChannel = (autoChannel + 1) % 16;
        return c;
    };

    // Note tracks
    for (const [trackIndex, track] of tracksArray.entries()) {
        const notesSrc = Array.isArray(track.events) ? track.events
            : (Array.isArray(track.notes) ? track.notes
                : (Array.isArray(track) ? track : []));
        const safeNotes = Array.isArray(notesSrc) ? notesSrc : [];

        const events = [];
        const label = track.label || track.name || '';
        if (label) {
            const labelBytes = writeString(label);
            events.push({
                tick: 0,
                sortOrder: -2,
                bytes: [0xff, 0x03, ...writeVarLen(labelBytes.length), ...labelBytes]
            });
        }

        const channel = resolveChannel(track);

        // The instrument, when the track names a General MIDI program: a
        // number, { gm } or { program }. A drum channel has no program, and a
        // sampler name is not one (see export-losses).
        const program = typeof track.synth === "number" ? track.synth
            : (typeof track.synth?.gm === "number" ? track.synth.gm
                : (typeof track.synth?.program === "number" ? track.synth.program : null));
        if (program !== null && channel !== 9 && program >= 0 && program <= 127) {
            events.push({ tick: 0, sortOrder: -1, bytes: [0xc0 | channel, Math.round(program)] });
        }

        // Add time to notes if missing
        let currentTime = 0;
        const notesWithTime = safeNotes.map(note => {
            const t = note.time !== undefined ? note.time : currentTime;
            currentTime = t + (note.duration || 1);
            return { ...note, time: t };
        });

        // Staccato/tenuto and accent/marcato were compiled into modulations the
        // writer then dropped, because the only one it read was `pitch`. Both
        // are things MIDI says directly — a shorter note and a louder one — so
        // they are applied to the note instead of becoming controller events.
        const perIndex = modulationsByNote(notesWithTime, bpm);

        // Control changes first, and before the MPE branch, so they are written
        // on whichever channel governs the track: its own, or the MPE master
        // zone that the notes are spread across.
        events.push(...buildControlEvents(controllerEvents(track, piece, trackIndex), channel, ticksPerBeat));

        if (mpe) {
            // One channel per note, so every note can carry its own wheel:
            // its tuning, and its bend. Throws if the texture is denser than
            // the member channels, because two notes on one channel cannot
            // both be tuned and a file that quietly mis-tunes is worse than no
            // file.
            const zone = { ...MPE_DEFAULTS, ...mpeConfig, ticksPerBeat };
            const plan = buildMpeNoteEvents(notesWithTime, zone);
            events.push(...plan.events);
            const { written } = pitchWheelPlan(pitchWheelCurves(notesWithTime), (index) => plan.channelOf.get(index));
            events.push(...pitchWheelEvents(written, ticksPerBeat, { range: zone.bendRange, sensitivity: false }));
            if (plan.channelsUsed.length > 1) {
                // Expression and dynamics, on the master channel, so one
                // place governs the zone.
                for (const m of (modulationsByNote(notesWithTime, bpm).get(0) || [])) {
                    if (m.type === "amplitude") {
                        events.push({ tick: 0, sortOrder: -1, bytes: [0xb0 | masterChannel, 11, 64] });
                        break;
                    }
                }
            }
            trackChunks.push(encodeTrack(events));
            continue;
        }

        for (let i = 0; i < notesWithTime.length; i++) {
            const note = notesWithTime[i];
            if (note.pitch === null || note.pitch === undefined) continue; // rest
            // Accept scalar pitch or array (chord from Chain branching etc.)
            const pitches = Array.isArray(note.pitch) ? note.pitch : [note.pitch];
            const mods = perIndex.get(i) || [];

            const durationBeats = applyDurationScale(note, mods);
            const startTick = Math.round((note.time || 0) * ticksPerBeat);
            // At least one tick: a note-on with no note-off is a stuck key.
            const endTick = Math.max(
                startTick + 1,
                Math.round(((note.time || 0) + durationBeats) * ticksPerBeat),
            );

            // Boosts compose, and a note-on byte is 1..127.
            const velocity = Math.max(1, Math.min(
                127,
                Math.round(applyVelocityBoost(note, mods) * 127),
            ));

            for (const p of pitches) {
                if (typeof p !== 'number') continue;
                events.push({
                    tick: startTick,
                    sortOrder: 1,
                    bytes: [0x90 | channel, p, velocity]
                });
                events.push({
                    tick: endTick,
                    sortOrder: 0, // note-off sorts before note-on at same tick
                    bytes: [0x80 | channel, p, 0]
                });
            }
        }

        // A note's tuning and bend are one wheel curve (see pitch-wheel.js).
        // Curves that overlap on this one channel cannot all be drawn: the
        // later ones are left unbent, and export-losses reports them.
        const { written } = pitchWheelPlan(pitchWheelCurves(notesWithTime), () => channel);
        events.push(...pitchWheelEvents(written, ticksPerBeat));

        // And the dynamics that are not pitch: CC 11, which a synth applies to
        // itself. A term MIDI cannot say is left out rather than approximated
        // into something that means a different thing.
        events.push(...buildExpressionEvents(notesWithTime, channel, ticksPerBeat));

        trackChunks.push(encodeTrack(events));
    }

    // Assemble file
    const numTracks = trackChunks.length;
    const fileBytes = [];

    // Header: MThd
    fileBytes.push(...writeString('MThd'));
    fileBytes.push(...writeUint32(6)); // header length
    fileBytes.push(...writeUint16(1)); // format 1 (multi-track)
    fileBytes.push(...writeUint16(numTracks));
    fileBytes.push(...writeUint16(ticksPerBeat));

    // Track chunks
    for (const trackData of trackChunks) {
        fileBytes.push(...writeString('MTrk'));
        fileBytes.push(...writeUint32(trackData.length));
        fileBytes.push(...trackData);
    }

    return new Uint8Array(fileBytes);
}

/**
 * Render compiled pitch curves (anchors in cents) as MIDI pitch wheel events.
 *
 * Emits an RPN 0 (pitch bend sensitivity) setup sized to the widest curve on
 * the track — MIDI's ±2 semitone default would clip wider glissandi — then
 * samples each curve's linear segments and recenters the wheel at note end.
 *
 * @param {Array<Object>} notes - track notes with resolved numeric times
 * @param {number} channel - MIDI channel (0-15)
 * @param {number} ticksPerBeat
 * @returns {Array<{tick:number,sortOrder:number,bytes:number[]}>}
 */
/**
 * Approximate a tempo ramp as a staircase of set-tempo events.
 *
 * An accelerando is written as automation targeting `tempo`, which the players
 * ramp continuously on `Transport.bpm`. Standard MIDI File has no such
 * message — a tempo is a step that holds until the next one — so a curve can
 * only be sampled. Steps land on a sixteenth-note grid, and a step is skipped
 * when it would repeat the previous rounded tempo, so a slow ramp does not
 * fill the track with identical events.
 *
 * @param {Object} piece - JMON piece
 * @param {number} ticksPerBeat
 * @returns {Array<{tick: number, sortOrder: number, bytes: Array<number>}>}
 */
function buildTempoRampEvents(piece, ticksPerBeat) {
    const ramps = automationChannels(piece)
        .filter(channel => parseAutomationTarget(channel.target).kind === 'tempo');
    if (ramps.length === 0) return [];

    const events = [];
    const stepBeats = 0.25;
    const written = new Set();   // one tempo per tick, so ramps don't stack

    const emit = (beat, bpm) => {
        const tick = Math.round(beat * ticksPerBeat);
        if (written.has(tick)) return;
        written.add(tick);
        const microsecondsPerBeat = Math.round(60000000 / bpm);
        events.push({
            tick,
            sortOrder: -1,
            bytes: [0xff, 0x51, 0x03,
                (microsecondsPerBeat >> 16) & 0xff,
                (microsecondsPerBeat >> 8) & 0xff,
                microsecondsPerBeat & 0xff]
        });
    };

    for (const ramp of ramps) {
        for (let k = 0; k < ramp.points.length; k++) {
            const from = ramp.points[k];
            const to = ramp.points[k + 1];
            emit(from.time, from.value);
            if (!to || to.time <= from.time) continue;

            let previous = Math.round(from.value);
            const span = to.time - from.time;
            for (let beat = from.time + stepBeats; beat < to.time; beat += stepBeats) {
                const value = from.value + (to.value - from.value) * ((beat - from.time) / span);
                const rounded = Math.round(value);
                if (rounded === previous) continue;
                emit(beat, rounded);
                previous = rounded;
            }
        }
    }

    return events;
}

// --- Public API ---

export class Midi {
    static midiToNoteName(midi) {
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(midi / 12) - 1;
        const noteIndex = midi % 12;
        return noteNames[noteIndex] + octave;
    }
    static convert(piece) {
        const bpm = piece.tempo || piece.bpm || 120;
        const timeSignature = piece.timeSignature || '4/4';
        const rawTracks = piece.tracks || [];
        const tracksArray = Array.isArray(rawTracks)
            ? rawTracks
            : (rawTracks && typeof rawTracks === 'object' ? Object.values(rawTracks) : []);

        return {
            header: { bpm, timeSignature },
            tracks: tracksArray.map(track => {
                const label = track.label || track.name;
                const notesSrc = Array.isArray(track.events) ? track.events
                                : (Array.isArray(track.notes) ? track.notes
                                : (Array.isArray(track) ? track : []));
                const safeNotes = Array.isArray(notesSrc) ? notesSrc : [];
                const perf = compileEvents({ events: safeNotes }, { tempo: bpm, timeSignature });

                const notes = safeNotes.map(note => ({
                    pitch: note.pitch,
                    noteName: (typeof note.pitch === 'number') ? Midi.midiToNoteName(note.pitch) : note.pitch,
                    time: note.time,
                    duration: note.duration,
                    velocity: note.velocity || 0.8
                }));

                return {
                    label,
                    notes,
                    modulations: (perf && Array.isArray(perf.modulations)) ? perf.modulations : []
                };
            })
        };
    }
}

/**
 * Encode a JMON piece as a Standard MIDI File and return the raw bytes.
 * DOM-free — safe to call from Node, Deno, and notebook kernels.
 *
 * @param {Object} piece - The JMON piece
 * @returns {Uint8Array} The SMF byte stream
 */
export function midiBytes(piece, options = {}) {
    return buildMidiFile(piece, options);
}

/**
 * Encode a JMON piece as a base64-encoded MIDI file. Useful for
 * embedding in data: URLs or handing to notebook MIDI players that expect
 * a string payload. DOM-free.
 *
 * @param {Object} piece - The JMON piece
 * @returns {string} Base64-encoded SMF bytes (no data: prefix)
 */
export function midiBase64(piece, options = {}) {
    const bytes = buildMidiFile(piece, options);
    return bytesToBase64(bytes);
}

/**
 * Build a MIME bundle for displaying a MIDI file in a notebook. Includes
 * both `audio/midi` (for hosts that can render it) and `text/html` (a
 * data-URL download link, which JupyterLab and most kernels *will* render).
 * Hand the result to `jm.env.present()` to display inline.
 *
 * @param {Object} piece - The JMON piece
 * @param {Object} [options]
 * @param {string} [options.filename='piece.mid'] - Download filename
 * @param {string} [options.label] - Link label; defaults to the filename
 * @returns {Object} MIME bundle: {audio/midi, text/html, text/plain}
 *
 * @example
 * jm.env.present(jm.midiDisplay(piece));
 */
export function midiDisplay(piece, options = {}) {
    const {
        filename = "piece.mid",
        label,
    } = options;
    const bytes = buildMidiFile(piece, options);
    const b64 = bytesToBase64(bytes);
    const sizeKb = (bytes.length / 1024).toFixed(1);
    const linkLabel = label || `⬇ ${filename} (${sizeKb} KB)`;
    // Inline, no external CSS — works in any kernel that renders text/html.
    const html =
        `<a href="data:audio/midi;base64,${b64}" download="${escapeHtml(filename)}" ` +
        `style="display:inline-block;padding:6px 12px;background:#2b2b2b;color:#fff;` +
        `border-radius:4px;text-decoration:none;font-family:sans-serif;font-size:13px">` +
        `${escapeHtml(linkLabel)}</a>`;
    return {
        "audio/midi": b64,
        "text/html": html,
        "text/plain": `MIDI (${bytes.length} bytes)`,
    };
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Build an interactive in-notebook MIDI player. Returns a MIME bundle
 * whose `text/html` content is an iframe hosting the `html-midi-player`
 * web component (Magenta + Tone.js, loaded from jsDelivr) pointed at a
 * `data:audio/midi;base64,...` URL. Gives actual play/pause/seek inside
 * Jupyter without any extension.
 *
 * The player is embedded inside an iframe `srcdoc` for two reasons:
 *   1. CDN scripts load in a clean document context, avoiding conflicts
 *      with whatever Jupyter has already loaded in the parent page.
 *   2. CSP / script restrictions on the parent page don't affect us.
 *
 * @param {Object} piece - The JMON piece
 * @param {Object} [options]
 * @param {boolean} [options.visualizer=true] - Render the Magenta piano-roll
 *   visualizer above the player controls.
 * @param {string} [options.soundFont] - URL of a soundfont. Defaults to
 *   Magenta's general-MIDI soundfont hosted on Google Cloud Storage.
 * @param {number} [options.height] - iframe height in pixels. Defaults to
 *   220 (visualizer + controls) or 80 (controls only).
 * @returns {Object} MIME bundle: { text/html, audio/midi, text/plain }
 *
 * @example
 * jm.env.present(jm.midiPlayer(piece));
 */
export function midiPlayer(piece, options = {}) {
    const {
        visualizer = true,
        soundFont = "https://storage.googleapis.com/magentadata/js/soundfonts/sgm_plus",
        height: iframeHeight = visualizer ? 220 : 80,
    } = options;

    const bytes = buildMidiFile(piece, options);
    const b64 = bytesToBase64(bytes);
    const dataUrl = `data:audio/midi;base64,${b64}`;

    // html-midi-player bundles tone.js + @magenta/music into one script.
    // Version 1.5.0 is the current stable as of writing.
    const playerScript =
        "https://cdn.jsdelivr.net/combine/" +
        "npm/tone@14.7.77," +
        "npm/@magenta/music@1.23.1/es6/core.js," +
        "npm/focus-visible@5," +
        "npm/html-midi-player@1.5.0";

    const visualizerEl = visualizer
        ? `<midi-visualizer type="piano-roll" id="vis" src="${dataUrl}"></midi-visualizer>`
        : "";
    const playerEl = `<midi-player src="${dataUrl}" sound-font="${soundFont}"${visualizer ? ' visualizer="#vis"' : ""}></midi-player>`;

    const doc =
        `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<script src="${playerScript}"></script>` +
        `<style>` +
        `body{margin:0;padding:4px;font-family:system-ui,sans-serif;background:transparent}` +
        `midi-player{display:block;width:100%;margin-top:4px;` +
        `--midi-player-font-family:system-ui,sans-serif}` +
        `midi-visualizer{display:block;width:100%;height:120px;` +
        `--midi-visualizer-active-note-color:#0af}` +
        `</style></head><body>${visualizerEl}${playerEl}</body></html>`;

    // srcdoc needs double-quotes escaped so we can wrap it in double-quotes.
    const srcdoc = doc.replace(/"/g, "&quot;");
    const html =
        `<iframe srcdoc="${srcdoc}" ` +
        `style="width:100%;height:${iframeHeight}px;border:none;display:block" ` +
        `sandbox="allow-scripts allow-same-origin"></iframe>`;

    return {
        "text/html": html,
        "audio/midi": b64,
        "text/plain": `MIDI player (${bytes.length} bytes)`,
    };
}

/**
 * Minimal, dependency-free Uint8Array -> base64.
 * Works in browsers (btoa), Node (Buffer), and Deno (btoa). We avoid
 * importing `Buffer` so the core library stays environment-agnostic.
 */
function bytesToBase64(bytes) {
    // btoa is available in browsers and Deno; Node 16+ exposes it too.
    if (typeof btoa === "function") {
        // Build a binary string in chunks to avoid blowing the call stack on
        // large buffers when using String.fromCharCode(...bytes).
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    }
    // Last-resort fallback for hosts without btoa or Buffer.
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "";
    let i = 0;
    while (i < bytes.length) {
        const b1 = bytes[i++];
        const b2 = i < bytes.length ? bytes[i++] : 0;
        const b3 = i < bytes.length ? bytes[i++] : 0;
        const triplet = (b1 << 16) | (b2 << 8) | b3;
        output += chars[(triplet >> 18) & 0x3f];
        output += chars[(triplet >> 12) & 0x3f];
        output += i - 1 > bytes.length ? "=" : chars[(triplet >> 6) & 0x3f];
        output += i > bytes.length ? "=" : chars[triplet & 0x3f];
    }
    return output;
}

/**
 * Convert a JMON piece to a MIDI output. In a browser this returns
 * an `<a>` download link (the original behavior). In headless environments
 * it returns the raw `Uint8Array` so callers can pipe it to a file or
 * notebook display helper.
 *
 * For an explicit, environment-agnostic API prefer `midiBytes()` or
 * `midiBase64()`.
 *
 * @param {Object} piece - The JMON piece
 * @param {Object} [options] - Options
 * @param {string} [options.filename='piece.mid'] - Filename used for
 *   the download link text (browser only)
 * @returns {HTMLAnchorElement|Uint8Array}
 *
 * @example
 * display(jm.midi(piece));
 * display(jm.midi(piece, { filename: "my-song.mid" }));
 */
export function midi(piece, options = {}) {
    const { filename = 'piece.mid' } = options;
    const bytes = buildMidiFile(piece, options);

    // Headless path: no DOM, return the bytes directly.
    if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") {
        return bytes;
    }

    const blob = new Blob([bytes], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.textContent = `Download ${filename}`;
    return a;
}
