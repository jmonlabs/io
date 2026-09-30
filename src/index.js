/**
 * jmon/io — the JMON format: what it means, and how it serialises.
 *
 * Two layers.
 *
 * `format/` is the semantics: what a `tempoMap` does to a beat position, what
 * a `keySignature` string means, what an articulation compiles to. Pure
 * functions over a piece, no audio and no DOM.
 *
 * The rest is serialisation: Standard MIDI File both directions and MusicXML.
 *
 * No dependencies, and no imports outside this package. ESM source served from
 * GitHub via jsDelivr, no build step.
 *
 * @license GPL-3.0-or-later
 */

export {
  midi,
  midiBytes,
  midiBase64,
  midiDisplay,
  midiPlayer,
} from "./midi.js";

export { parseMidiFile } from "./midi-parser.js";
export { MidiToJmon, midiToJmon } from "./midi-to-jmon.js";
export { musicxml, downloadMusicXML } from "./musicxml.js";

// The format layer, exported because it is the useful half for anyone reading
// a piece rather than writing one out.
export {
  readTime,
  tempoSegments,
  beatsToSeconds,
  tempoAt,
  readBeatsPerBar,
  timeSignatureSegments,
  keySignatureSegments,
  parseKeySignature,
  automationChannels,
  parseAutomationTarget,
  resolveCcHint,
  scaleToRange,
  KEY_NAMES_MAJOR,
  KEY_NAMES_MINOR,
} from "./format/timeline.js";

export { controllerEvents, noteRelativeBeats } from "./format/controllers.js";

export {
  compilePerformance,
  compilePerformanceTrack,
  compileEvents,
  compilePiece,
} from "./format/performance.js";

export { deriveVisualFromArticulations } from "./format/notation.js";

// What the MIDI export will not carry, declared beside the writer that drops it.
export {
  exportLosses, midiLosses, EXPORT_TARGETS,
  MIDI_RENDERED_MODULATIONS, MUSICXML_RENDERED_MODULATIONS,
} from "./export-losses.js";

export { JmonValidator } from "./format/validate.js";

import * as midiModule from "./midi.js";
import { parseMidiFile } from "./midi-parser.js";
import { midiToJmon, MidiToJmon } from "./midi-to-jmon.js";
import * as musicxmlModule from "./musicxml.js";
import * as timeline from "./format/timeline.js";
import * as performance from "./format/performance.js";
import * as controllers from "./format/controllers.js";
import { JmonValidator } from "./format/validate.js";
import { deriveVisualFromArticulations } from "./format/notation.js";
import { exportLosses } from "./export-losses.js";

export const VERSION = "1.0.0";

/** Everything, for `import io from ".../io/src/index.js"`. */
export const io = {
  VERSION,

  // Standard MIDI File, both directions.
  midi: midiModule.midi,
  midiBytes: midiModule.midiBytes,
  midiBase64: midiModule.midiBase64,
  midiDisplay: midiModule.midiDisplay,
  midiPlayer: midiModule.midiPlayer,
  parseMidiFile,
  midiToJmon,
  MidiToJmon,

  // MusicXML. Rendering it to a score is a separate job, and a browser one:
  // it needs Verovio and produces a DOM element, so it stays with the players.
  musicxml: musicxmlModule.musicxml,
  downloadMusicXML: musicxmlModule.downloadMusicXML,


  // What the format means. `format` is also what a host injects when it needs
  // to read a piece without depending on this package by URL.
  format: {
    ...timeline,
    ...controllers,
    compilePerformance: performance.compilePerformance,
    compilePerformanceTrack: performance.compilePerformanceTrack,
    compileEvents: performance.compilePerformanceTrack,
    compilePiece: performance.compilePerformance,
    deriveVisualFromArticulations,
    JmonValidator,
  },

  /**
   * Is this a valid piece, and — for a named target — what will not survive
   * the trip?
   *
   *     io.validate(piece)                    // { valid, errors, normalized }
   *     io.validate(piece, { for: "midi" })   // …plus `warnings`
   *
   * The warnings are not errors. They are the fields the writer cannot express,
   * and the writer does not say so: a `loop` used to arrive in the DAW doing
   * nothing, with no error anywhere. Pass the target you are exporting for and
   * find out first. A note field under its old name (`microtuning`,
   * `pitchEnvelope`, `amplitudeEnvelope`) is renamed in `normalized`, and
   * that is a warning too, whatever the target.
   *
   * @param {Object} piece
   * @param {Object} [options]
   * @param {"midi"|"musicxml"} [options.for] - The export target to check against.
//   *   Each loss says whether the format cannot express the field (kind
//   *   "format", nothing to do) or this writer does not yet (kind "writer",
//   *   a to-do).
   * @returns {{valid:boolean, errors:string[], normalized:Object|null, warnings?:Array}}
   */
  /**
   * Is this a valid piece, and — for a named target — what will not survive
   * the trip?
   *
   *     io.validate(piece)                    // { valid, errors, normalized }
   *     io.validate(piece, { for: "midi" })   // …plus `warnings`
   *
   * The warnings are not errors. They are the fields the writer cannot express,
   * and the writer does not say so: a `loop` used to arrive in the DAW doing
   * nothing, with no error anywhere. Pass the target you are exporting for and
   * find out first. A note field under its old name (`microtuning`,
   * `pitchEnvelope`, `amplitudeEnvelope`) is renamed in `normalized`, and
   * that is a warning too, whatever the target.
   *
   * @param {Object} piece
   * @param {Object} [options]
   * @param {"midi"} [options.for] - The export target to check against
   * @returns {{valid:boolean, errors:string[], normalized:Object|null, warnings?:Array}}
   */
  validate(piece, options = {}) {
    const result = new JmonValidator().validateAndNormalize(piece);
    if (options.for) {
      result.warnings = [...(result.warnings ?? []), ...exportLosses(piece, options.for)];
    }
    return result;
  },
};

export default io;