import { compilePerformanceTrack } from "./format/performance.js";

/**
 * What the MIDI export will not carry.
 *
 * Every entry here was found by exporting a piece with the field and reading
 * the bytes back: the writer has no way to say it, so the field arrived doing
 * nothing. The list lives beside the writer that drops them rather than in a
 * doc or a test, so the two cannot drift — adding a field the writer cannot
 * express and forgetting to add it here is the only way to get it wrong.
 *
 * These are warnings, not errors. A piece is a valid piece; it just does not
 * survive the trip to a DAW intact, and that is worth knowing before you make
 * the file rather than after.
 */

/**
 * Modulation types the writer renders, and how.
 *
 * `pitch` is drawn as a pitch wheel (RPN 0/0 sensitivity, then 14-bit bend);
 * `durationScale` and `velocityBoost` are applied to the note itself;
 * `amplitude` becomes CC 11. Anything else, and any `pitch` without anchors,
 * is dropped.
 *
 * @type {Object<string, string>}
 */
export const MIDI_RENDERED_MODULATIONS = {
  pitch: "a pitch wheel",
  durationScale: "the note's duration",
  velocityBoost: "the note's velocity",
  amplitude: "CC 11",
};

/** Note fields the writer reads. Anything else on a note is ignored. */
const RENDERED_NOTE_FIELDS = new Set([
  "pitch", "duration", "time", "velocity",
  "articulations", "articulation", "glissTarget", "pitchEnvelope",
]);

/** Track and piece fields the writer reads. */
const RENDERED_TRACK_FIELDS = new Set([
  "label", "name", "notes", "events", "synth", "instrument",
  "channel", "midiChannel", "output", "gain", "pan",
]);

/**
 * Everything in `piece` that the MIDI export will not carry.
 *
 * @param {Object} piece - A JMON piece
 * @returns {Array<{path:string, field:string, why:string}>} one entry per
 *   distinct loss, in the order first encountered
 */
export function midiLosses(piece) {
  const out = [];
  const seen = new Set();
  const add = (path, field, why) => {
    const key = `${path === piece ? "piece" : path.label}#${field}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({ path: path === piece ? "piece" : path.label, field, why });
    return true;
  };

  if (!piece || typeof piece !== "object") return out;

  // A reverb send has no MIDI message. It is also the one thing easy to forget
  // is in the piece at all, since it is not on a note.
  if (piece.audioGraph && (Array.isArray(piece.audioGraph) ? piece.audioGraph.length > 0 : true)) {
    add(piece, "audioGraph", "MIDI has no send or bus; set the reverb in the DAW");
  }

  const tracks = Array.isArray(piece.tracks) ? piece.tracks : [];
  for (const track of tracks) {
    if (!track || typeof track !== "object") continue;

    // A Standard MIDI File has no loop, so a looping track exports one pass.
    if (track.loop || track.loopEnd) {
      add(track, "loop", "a Standard MIDI File cannot loop; the track exports one pass only");
    }

    // A sampler name is a JMON thing. MIDI has a program number and nothing
    // else, so the choice of instrument does not survive.
    if (typeof track.synth === "string") {
      add(track, "synth", `a sampler name cannot be a program change ("${track.synth}")`);
    }

    for (const key of Object.keys(track)) {
      if (RENDERED_TRACK_FIELDS.has(key)) continue;
      add(track, key, "not written to MIDI");
    }

    for (const note of Array.isArray(track.notes) ? track.notes : []) {
      if (!note || typeof note !== "object" || note.pitch === null) continue;

      if (note.microtuning != null) {
        add(note, "microtuning",
          "a per-note cents offset needs MPE or a pitch wheel; the written pitch is exported");
      }
      if (note.channel != null) {
        add(note, "channel",
          `the writer takes the channel from the track (track.channel), not the note (${note.channel})`);
      }
      if (Array.isArray(note.modulations)) {
        add(note, "modulations",
          "modulations on a note are not read; use articulations or pitchEnvelope");
      }
      for (const key of Object.keys(note)) {
        if (RENDERED_NOTE_FIELDS.has(key)) continue;
        add(note, key, "not written to MIDI");
      }
    }
  }

  // What the format layer derives that the writer cannot draw. Derived from the
  // two, so a new articulation type is caught here rather than vanishing.
  for (const track of tracks) {
    const notes = Array.isArray(track?.notes) ? track.notes : [];
    if (notes.length === 0) continue;
    let perf;
    try {
      perf = compilePerformanceTrack({ notes }, { tempo: piece.tempo ?? 120 });
    } catch (_) {
      continue;
    }
    for (const m of perf.modulations || []) {
      if (!MIDI_RENDERED_MODULATIONS[m.type]) {
        add(track, `articulation → ${m.type}`,
          `the format layer derives a ${m.type} modulation the MIDI writer does not render`);
      } else if (m.type === "pitch" && !(Array.isArray(m.anchors) && m.anchors.length > 0)) {
        // vibrato and tremolo both compile to a rate and a depth rather than a
        // curve, so the wheel writer has nothing to draw.
        add(track, `articulation → ${m.subtype ?? "pitch"}`,
          "compiled to a rate and depth rather than a curve, so there is nothing for the pitch wheel to draw");
      }
    }
  }

  return out;
}
