import { compilePerformanceTrack } from "./format/performance.js";

/**
 * What each exporter will not carry.
 *
 * Every entry was found by exporting a piece with the field and reading the
 * result back: the writer says nothing when it cannot write something, so the
 * field arrived doing nothing. The lists live beside the writers rather than in
 * a doc or a test, so the two cannot drift.
 *
 * **A loss is one of two kinds, and the difference matters.**
 *
 * - `format` — the interchange format has no way to say it. A Standard MIDI
 *   File has no send bus and cannot loop; there is nothing a better writer
 *   would do about it. Set the reverb in the DAW.
 * - `writer` — the format has a place for it and this exporter does not write
 *   it. MusicXML has `<notations>` and `<dynamics>`; the writer emits neither.
 *   That is a to-do, not a wall.
 *
 * Collapsing the two would make the list useless for deciding what to build
 * next, so they are kept apart.
 */

/**
 * @typedef {Object} Exporter
 * @property {Object<string,string>} modulations - modulation type -> how it is written
 * @property {Set<string>} noteFields - note fields the writer reads
 * @property {Set<string>} trackFields - track fields the writer reads
 * @property {Set<string>} pieceFields - piece fields the writer reads
 * @property {Object<string,{why:string, kind:"format"|"writer"}>} fieldNotes
 */

/** @type {Object<string, Exporter>} */
const EXPORTERS = {
  midi: {
    // pitch -> a pitch wheel; duration and velocity -> the note itself;
    // amplitude -> CC 11. Anything else, and any pitch without anchors, is lost.
    modulations: {
      pitch: "a pitch wheel",
      durationScale: "the note's duration",
      velocityBoost: "the note's velocity",
      amplitude: "CC 11",
    },
    noteFields: new Set([
      "pitch", "duration", "time", "velocity",
      "articulations", "articulation", "glissTarget", "pitchEnvelope",
    ]),
    trackFields: new Set([
      "label", "name", "notes", "events", "synth", "instrument",
      "channel", "midiChannel", "output", "gain", "pan",
    ]),
    pieceFields: new Set(["title", "tempo", "bpm", "keySignature", "timeSignature", "tracks"]),
    fieldNotes: {
      audioGraph: {
        kind: "format",
        why: "MIDI has no send or a bus; set the reverb in the DAW",
      },
      loop: {
        kind: "format",
        why: "a Standard MIDI File cannot loop; the track is written one pass only",
      },
      microtuning: {
        kind: "format",
        why: "a per-note cents offset has no MIDI message; use MPE, or write the pitch bent",
      },
      // channel is read from the track, not the note
      channel: {
        kind: "writer",
        why: "the writer takes the channel from the track (track.channel), not the note",
      },
      modulations: {
        kind: "writer",
        why: "modulations on a note are not read; use articulations or pitchEnvelope",
      },
      // A program number is written; a sampler name is not. This one is decided
      // by the value rather than by the key, so it is checked separately below.
      synth: {
        kind: "format",
        why: "a sampler name cannot be a program change; MIDI names 128 instruments and nothing else",
      },
    },
  },

  musicxml: {
    // The writer emits notes, rests, chords, pitch, duration, type, key, time
    // signature, tempo, clef, part names and the title — and nothing else. No
    // <notations>, no <dynamics>, no <repeat>, no <midi-instrument>, so every
    // expressive field is currently a to-do.
    modulations: {},
    noteFields: new Set(["pitch", "duration", "time"]),
    trackFields: new Set(["label", "name", "notes", "clef"]),
    pieceFields: new Set([
      "title", "tempo", "bpm", "keySignature", "timeSignature", "tracks",
      "format", "version",
    ]),
    fieldNotes: {
      audioGraph: { kind: "format", why: "a score has no audio" },
      loop: {
        kind: "writer",
        why: "MusicXML has <barline><repeat>, which this writer does not emit; the bar is written once",
      },
      microtuning: {
        kind: "format",
        why: "a score names a pitch, not a tuning; <alter> is whole and half steps only",
      },
      articulations: {
        kind: "writer",
        why: "MusicXML has <notations><articulations>; this writer emits none",
      },
      articulation: {
        kind: "writer",
        why: "MusicXML has <notations><articulations>; this writer emits none",
      },
      pitchEnvelope: {
        kind: "writer",
        why: "MusicXML has <glissando>, <slide> and <ornaments>; this writer emits none",
      },
      velocity: {
        kind: "writer",
        why: "MusicXML has <dynamics>; this writer emits none, so dynamics are lost",
      },
      velocityBoost: { kind: "writer", why: "as for velocity: no <dynamics> is written" },
      durationScale: {
        kind: "writer",
        why: "a shorter note is written as a shorter <duration>, but the articulation behind it is not",
      },
      amplitude: { kind: "writer", why: "as for velocity: no <dynamics> is written" },
      synth: {
        kind: "writer",
        why: "MusicXML has <midi-instrument>; this writer writes only <part-name>",
      },
      channel: { kind: "writer", why: "a score has no channel" },
    },
  },
};

/** The export targets a piece can be checked against. */
export const EXPORT_TARGETS = Object.keys(EXPORTERS);

/**
 * Everything in `piece` that the named exporter will not carry.
 *
 * @param {Object} piece - A JMON piece
 * @param {string} [target="midi"] - one of `EXPORT_TARGETS`
 * @returns {Array<{path:string, field:string, why:string, kind:"format"|"writer"}>}
 *   one entry per distinct loss, in the order first encountered
 * @throws {Error} on an unknown target, so a typo does not silently pass
 */
export function exportLosses(piece, target = "midi") {
  const exporter = EXPORTERS[target];
  if (!exporter) {
    throw new Error(`exportLosses: unknown target "${target}" (${EXPORT_TARGETS.join(", ")})`);
  }
  const out = [];
  const seen = new Set();
  const add = (path, field, why, kind) => {
    const key = `${path}.${field}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, field, why, kind });
  };

  if (!piece || typeof piece !== "object") return out;

  if (piece.audioGraph && (Array.isArray(piece.audioGraph) ? piece.audioGraph.length > 0 : true)) {
    const hint = exporter.fieldNotes.audioGraph;
    add("piece", "audioGraph", hint.why, hint.kind);
  }
  for (const key of Object.keys(piece)) {
    if (exporter.pieceFields.has(key)) continue;
    add("piece", key, "not written by this exporter", "writer");
  }

  const tracks = Array.isArray(piece.tracks) ? piece.tracks : [];
  for (const track of tracks) {
    if (!track || typeof track !== "object") continue;
    const path = track.label || track.name || "track";

    // Read as a field, lost as a value. A program number survives; a sampler
    // name does not, and the key alone cannot tell them apart.
    if (typeof track.synth === "string") {
      const hint = exporter.fieldNotes.synth;
      add(path, "synth", hint.why, hint.kind);
    }

    for (const key of Object.keys(track)) {
      if (exporter.trackFields.has(key)) continue;
      const hint = exporter.fieldNotes[key];
      add(path, key, hint ? hint.why : "not written by this exporter", hint ? hint.kind : "writer");
    }

    for (const n of Array.isArray(track.notes) ? track.notes : []) {
      if (!n || typeof n !== "object" || n.pitch === null) continue;
      for (const key of Object.keys(n)) {
        if (exporter.noteFields.has(key)) continue;
        const hint = exporter.fieldNotes[key];
        add(path, key, hint ? hint.why : "not written by this exporter", hint ? hint.kind : "writer");
      }
    }

    // What the format layer derives that this writer cannot draw. Derived from
    // the two rather than transcribed, so a new articulation type is caught
    // here instead of vanishing.
    const notes = Array.isArray(track.notes) ? track.notes : [];
    if (notes.length === 0) continue;
    let perf;
    try {
      perf = compilePerformanceTrack({ notes }, { tempo: piece.tempo ?? 120 });
    } catch (_) {
      continue;
    }
    for (const m of perf.modulations || []) {
      if (!exporter.modulations[m.type]) {
        add(path, `articulation → ${m.type}`,
          "the format layer derives this and the writer draws nothing from it", "writer");
      } else if (m.type === "pitch" && !(Array.isArray(m.anchors) && m.anchors.length > 0)) {
        // vibrato and tremolo compile to a rate and a depth rather than a
        // curve, so a wheel writer has nothing to draw.
        add(path, `articulation → ${m.subtype ?? "pitch"}`,
          "compiled to a rate and a depth rather than a curve, so there is no curve to draw", "writer");
      }
    }
  }

  return out;
}

/** Losses for the MIDI writer. Kept because that is the one people ask for. */
export const midiLosses = (piece) => exportLosses(piece, "midi");

/** What the MIDI writer renders, and how. */
export const MIDI_RENDERED_MODULATIONS = EXPORTERS.midi.modulations;

/** What the MusicXML writer renders, and how. */
export const MUSICXML_RENDERED_MODULATIONS = EXPORTERS.musicxml.modulations;
