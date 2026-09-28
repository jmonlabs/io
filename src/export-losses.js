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
 *   it. Both writers now fill in the notation and the dynamics they have room
 *   for, so this list is short; when it is not, the entry is a to-do rather than
 *   a wall, and it says which.
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
      "channel", "midiChannel", "output", "gain", "pan", "cc",
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
    // Notes, rests, chords, pitch, duration, type, key, metre, tempo, clef, part
    // names and the title — and now the expression too: <notations>,
    // <dynamics>, <wedge>, <barline><repeat> and <midi-instrument>.
    //
    // Keys are "type/subtype" wherever one type has subtypes the writer treats
    // differently, and the bare type is left out then, so a subtype nobody taught
    // the writer is still reported instead of being assumed to be covered.
    modulations: {
      durationScale: "a mark in <notations>, not a shorter <duration>: a note's duration is the time to the next note, so shortening it opens a hole in the measure",
      velocityBoost: "the <dynamics> mark",
      "amplitude/crescendo": "a <wedge>",
      "amplitude/diminuendo": "a <wedge>",
      "amplitude/tremolo": "a <notations><ornaments><tremolo>",
      "pitch/glissando": "a <notations><glissando>",
      "pitch/portamento": "a <notations><slide>, opened and closed across two notes",
    },
    noteFields: new Set([
      "pitch", "duration", "time", "velocity",
      "articulations", "articulation", "glissTarget",
    ]),
    trackFields: new Set(["label", "name", "notes", "clef", "synth", "loop"]),
    pieceFields: new Set([
      "title", "tempo", "bpm", "keySignature", "timeSignature", "tracks",
      "format", "version",
    ]),
    fieldNotes: {
      audioGraph: { kind: "format", why: "a score has no audio" },
      microtuning: {
        kind: "format",
        why: "a score names a pitch, not a tuning; <alter> is whole and half steps only",
      },
      pitchEnvelope: {
        kind: "format",
        why: "a pitch envelope is a curve with a shape; <glissando> and <slide> are a straight line between two notes, and cannot hold it",
      },
      channel: { kind: "format", why: "a score has no channel" },
      cc: {
        kind: "format",
        why: "MusicXML has <technical>, which holds instrument-specific words, and nowhere to put a controller number; a score says dynamics and articulations, not CC",
      },
      // Decided by the value, not the key, so it is checked separately below: a
      // program number is written as <midi-program>, a sampler name cannot be.
      synth: {
        kind: "format",
        why: "a sampler name is not a MIDI program; a number is written as <midi-program>",
      },
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
      // A subtype can be drawn where its parent type cannot: a <glissando> and a
      // <slide> each come from a `pitch` modulation, and neither of them is a
      // pitch envelope. So the lookup is "type/subtype" first, then the type.
      const key = m.subtype ? `${m.type}/${m.subtype}` : m.type;
      const label = `articulation → ${key}`;
      if (!exporter.modulations[key] && !exporter.modulations[m.type]) {
        add(path, label,
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
