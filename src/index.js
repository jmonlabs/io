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

export {
  compilePerformance,
  compilePerformanceTrack,
  compileEvents,
  compilePiece,
} from "./format/performance.js";

export { deriveVisualFromArticulations } from "./format/notation.js";

export { JmonValidator } from "./format/validate.js";

import * as midiModule from "./midi.js";
import { parseMidiFile } from "./midi-parser.js";
import { midiToJmon, MidiToJmon } from "./midi-to-jmon.js";
import * as musicxmlModule from "./musicxml.js";
import * as timeline from "./format/timeline.js";
import * as performance from "./format/performance.js";
import { JmonValidator } from "./format/validate.js";
import { deriveVisualFromArticulations } from "./format/notation.js";

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
    compilePerformance: performance.compilePerformance,
    compilePerformanceTrack: performance.compilePerformanceTrack,
    compileEvents: performance.compilePerformanceTrack,
    compilePiece: performance.compilePerformance,
    deriveVisualFromArticulations,
    JmonValidator,
  },

  validate(piece) {
    return new JmonValidator().validateAndNormalize(piece);
  },
};

export default io;
