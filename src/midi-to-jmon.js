/**
 * MIDI to JMON Converter
 * Converts MIDI files to JMON format using Tone.js Midi parser
 * Follows existing patterns from music-player.js and other converters
 */

import { parseMidiFile } from "./midi-parser.js";
import { JmonValidator } from "./format/validate.js";

/**
 * MIDI to JMON Converter Class
 * Supports injectable Tone instance following existing patterns
 */
export class MidiToJmon {
  constructor(options = {}) {
    this.options = {
      // Injectable MIDI parser. Defaults to the built-in Standard MIDI File
      // reader, which needs no audio library. Pass `@tonejs/midi`'s `Midi`
      // class here if you would rather use it.
      parser: null,
      Tone: null,
      trackNaming: "auto", // 'auto', 'numbered', 'channel', 'instrument'
      mergeDrums: true,
      quantize: null, // e.g., 0.25 for 16th note quantization
      includeModulations: true,
      includeTempo: true,
      includeKeySignature: true,
      ...options,
    };
  }

  /**
   * Static conversion method
   * @param {ArrayBuffer|Uint8Array} midiData - MIDI file data
   * @param {Object} options - Conversion options
   * @returns {Promise<Object>} JMON composition
   */
  static async convert(midiData, options = {}) {
    const converter = new MidiToJmon(options);
    return await converter.convertToJmon(midiData);
  }

  /**
   * Main conversion method
   * @param {ArrayBuffer|Uint8Array} midiData - MIDI file data
   * @returns {Promise<Object>} JMON composition
   */
  convertToJmon(midiData) {
    let parsed;
    try {
      parsed = this.parseMidi(midiData);
    } catch (error) {
      throw new Error(`Failed to parse MIDI file: ${error.message}`);
    }

    // Convert to JMON format
    const composition = this.buildJmonComposition(parsed, null);

    // Validate output using existing validator
    const validator = new JmonValidator();
    const { valid, normalized, errors } = validator.validateAndNormalize(
      composition,
    );

    if (!valid) {
      console.warn("Generated JMON failed validation:", errors);
      // Return the composition anyway, but log the issues
    }

    return valid ? normalized : composition;
  }

  /**
   * Initialize Tone.js instance
   * @returns {Object} Tone.js instance
   */
  parseMidi(midiData) {
    // An explicit parser wins; then a `Midi` class handed in as `Tone`
    // (that is what @tonejs/midi exports, and what this converter used to
    // require); otherwise the built-in reader, which is the default.
    const injected = this.options.parser ??
      (this.options.Tone && this.options.Tone.Midi) ??
      null;

    if (injected) {
      return new injected(midiData);
    }
    return parseMidiFile(midiData);
  }

  /**
   * Build JMON composition from parsed MIDI
   * @param {Object} parsed - Parsed MIDI from Tone.js
   * @param {Object} Tone - Tone.js instance
   * @returns {Object} JMON composition
   */
  buildJmonComposition(parsed, Tone) {
    const composition = {
      format: "jmon",
      version: "1.0",
      tempo: this.extractTempo(parsed),
      tracks: this.convertTracks(parsed.tracks, Tone, parsed),
    };

    // Add optional properties if present
    const timeSignature = this.extractTimeSignature(parsed);
    if (timeSignature) {
      composition.timeSignature = timeSignature;
    }

    const keySignature = this.extractKeySignature(parsed);
    if (keySignature) {
      composition.keySignature = keySignature;
    }

    const metadata = this.extractMetadata(parsed);
    if (Object.keys(metadata).length > 0) {
      composition.metadata = metadata;
    }

    // Add tempo changes if present
    if (this.options.includeTempo && this.hasTempoChanges(parsed)) {
      composition.tempoMap = this.extractTempoMap(parsed);
    }

    // Add time signature changes if present
    if (this.hasTimeSignatureChanges(parsed)) {
      composition.timeSignatureMap = this.extractTimeSignatureMap(parsed);
    }

    return composition;
  }

  /**
   * Convert MIDI tracks to JMON tracks
   * @param {Array} tracks - MIDI tracks from Tone.js
   * @param {Object} Tone - Tone.js instance
   * @param {Object} parsed - Full parsed MIDI data
   * @returns {Array} JMON tracks
   */
  convertTracks(tracks, Tone, parsed) {
    const jmonTracks = [];
    let trackIndex = 0;

    for (const track of tracks) {
      // Skip empty tracks
      if (!track.notes || track.notes.length === 0) {
        continue;
      }

      const trackName = this.generateTrackName(track, trackIndex, parsed);
      const isDrumTrack = this.isDrumTrack(track);

      // Convert notes
      const notes = track.notes.map((note) =>
        this.convertNote(note, Tone, track, parsed?.timeUnit || "seconds")
      );

      // Apply quantization if requested
      const processedNotes = this.options.quantize
        ? this.quantizeNotes(notes, this.options.quantize)
        : notes;

      const jmonTrack = {
        label: trackName,
        notes: processedNotes,
      };

      // Add MIDI channel if available
      if (track.channel !== undefined) {
        jmonTrack.midiChannel = track.channel;
      }

      // Add instrument information if available
      if (track.instrument) {
        jmonTrack.synth = {
          type: isDrumTrack ? "Sampler" : "PolySynth",
          options: this.getInstrumentOptions(track.instrument, isDrumTrack),
        };
      }

      // Add control changes as modulations if requested
      if (this.options.includeModulations && track.controlChanges) {
        const modulations = this.extractModulations(track.controlChanges);
        if (modulations.length > 0) {
          // Add modulations to individual notes or as track-level automation
          this.applyModulationsToTrack(jmonTrack, modulations);
        }
      }

      jmonTracks.push(jmonTrack);
      trackIndex++;
    }

    return jmonTracks;
  }

  /**
   * Convert MIDI note to JMON note
   * @param {Object} note - MIDI note from Tone.js
   * @param {Object} Tone - Tone.js instance
   * @param {Object} track - Parent track for context
   * @returns {Object} JMON note
   */
/**
   * Recover a slide from a note's pitch bend envelope.
   *
   * The export writes a glissando as a bend sweeping from centre to its
   * depth across the note. Reading it back means looking at where the bend
   * has arrived by the time the note ends: a sweep that starts near centre
   * and lands somewhere else is a slide to `pitch + semitones`. A bend that
   * is already off-centre when the note starts is a fixed bend, not a slide.
   *
   * @returns {Object|null} A JMON articulation, or null if there is no bend
   */
  recoverSlide(note, track) {
    const bends = track?.pitchBends;
    if (!Array.isArray(bends) || bends.length === 0) return null;

    const range = track.pitchBendRange || 2;
    const start = note.time;
    const end = note.time + note.duration;
    // Half-open: a bend sitting exactly on the note's end belongs to what
    // follows, not to this note.
    const inWindow = bends.filter((b) => b.time >= start - 1e-6 && b.time < end - 1e-6);
    // The wheel holds one value at a time, so several bends stamped on the
    // same tick are one state, not a movement. Only the last survives. This
    // is what keeps a previous sweep's arrival and its recentre — both
    // landing on the boundary tick — from reading as a bend of this note's
    // own.
    const within = inWindow.filter(
      (b, i) => i === inWindow.length - 1 || Math.abs(inWindow[i + 1].time - b.time) > 1e-6,
    );
    if (within.length < 2) return null;

    const first = within[0].value * range;
    const last = within.at(-1).value * range;
    const depth = last - first;

    // A semitone's worth of movement is the floor; below that it is vibrato
    // or rounding, not a slide.
    if (Math.abs(depth) < 0.5) return null;

    if (Math.abs(first) < 0.05) {
      return { type: "glissando", target: Math.round(note.midi + depth) };
    }
    return { type: "bend", amount: Number(depth.toFixed(3)) };
  }

  convertNote(note, Tone, track, timeUnit = "seconds") {
    const inBeats = timeUnit === "beats";

    // The built-in parser reports quarter notes, which is what JMON stores, so
    // the values pass straight through and round-trip exactly. An injected
    // @tonejs/midi reports seconds, which have to be converted — and its
    // duration gets snapped to the nearest note value, which is lossy.
    const jmonNote = {
      pitch: note.midi,
      time: inBeats
        ? note.time
        : this.convertSecondsToQuarterNotes(note.time, note.tempo || 120),
      duration: inBeats
        ? note.duration
        : this.convertDurationToNoteValue(note.duration),
      velocity: note.velocity,
    };

    // Recover a slide written as pitch bend by the export.
    const slide = inBeats ? this.recoverSlide(note, track) : null;
    if (slide) {
      jmonNote.articulations = [...(jmonNote.articulations || []), slide];
    }

    // Add modulations if present on this note
    if (this.options.includeModulations && note.controlChanges) {
      const noteModulations = this.convertNoteModulations(note.controlChanges);
      if (noteModulations.length > 0) {
        jmonNote.modulations = noteModulations;
      }
    }

    return jmonNote;
  }

  /**
   * Generate track name based on naming strategy
   * @param {Object} track - MIDI track
   * @param {number} index - Track index
   * @param {Object} parsed - Full parsed MIDI
   * @returns {string} Track name
   */
  generateTrackName(track, index, parsed) {
    switch (this.options.trackNaming) {
      case "numbered":
        return `Track ${index + 1}`;

      case "channel":
        return `Channel ${(track.channel || 0) + 1}`;

      case "instrument":
        if (track.instrument) {
          return track.instrument.name ||
            `Instrument ${track.instrument.number}`;
        }
        return `Track ${index + 1}`;

      case "auto":
      default:
        // Try to detect meaningful names
        if (track.name && track.name.trim()) {
          return track.name.trim();
        }

        if (this.isDrumTrack(track)) {
          return "Drums";
        }

        if (track.instrument && track.instrument.name) {
          return track.instrument.name;
        }

        if (track.channel !== undefined) {
          return track.channel === 9 ? "Drums" : `Channel ${track.channel + 1}`;
        }

        return `Track ${index + 1}`;
    }
  }

  /**
   * Check if track is a drum track (channel 10/9 in MIDI)
   * @param {Object} track - MIDI track
   * @returns {boolean} True if drum track
   */
  isDrumTrack(track) {
    return track.channel === 9; // MIDI channel 10 (0-indexed as 9)
  }

  /**
   * Get instrument options for synth configuration
   * @param {Object} instrument - MIDI instrument info
   * @param {boolean} isDrum - Whether this is a drum track
   * @returns {Object} Synth options
   */
  getInstrumentOptions(instrument, isDrum) {
    if (isDrum) {
      // For drum tracks, we could map to specific drum samples
      return {
        envelope: {
          enabled: true,
          attack: 0.02,
          decay: 0.1,
          sustain: 0.8,
          release: 0.3,
        },
      };
    }

    // For melodic instruments, return basic synth options
    return {
      oscillator: { type: "triangle" },
      envelope: {
        attack: 0.1,
        decay: 0.2,
        sustain: 0.7,
        release: 1,
      },
    };
  }

  /**
   * Extract tempo from MIDI
   * @param {Object} parsed - Parsed MIDI
   * @returns {number} BPM
   */
  extractTempo(parsed) {
    // Tone.js Midi provides tempoEvents or we can use header info
    if (
      parsed.header && parsed.header.tempos && parsed.header.tempos.length > 0
    ) {
      return Math.round(parsed.header.tempos[0].bpm);
    }

    // Look for tempo events in tracks
    for (const track of parsed.tracks) {
      if (track.tempoEvents && track.tempoEvents.length > 0) {
        return Math.round(track.tempoEvents[0].bpm);
      }
    }

    return 120; // Default tempo
  }

  /**
   * Extract time signature from MIDI
   * @param {Object} parsed - Parsed MIDI
   * @returns {string|null} Time signature like "4/4"
   */
  extractTimeSignature(parsed) {
    // Look for time signature in header or tracks
    if (
      parsed.header && parsed.header.timeSignatures &&
      parsed.header.timeSignatures.length > 0
    ) {
      const ts = parsed.header.timeSignatures[0];
      return `${ts.numerator}/${ts.denominator}`;
    }

    // Look in tracks for time signature events
    for (const track of parsed.tracks) {
      if (track.timeSignatureEvents && track.timeSignatureEvents.length > 0) {
        const ts = track.timeSignatureEvents[0];
        return `${ts.numerator}/${ts.denominator}`;
      }
    }

    return null; // Let JMON use default
  }

  /**
   * Extract key signature from MIDI
   * @param {Object} parsed - Parsed MIDI
   * @returns {string|null} Key signature like "C", "G", "Dm"
   */
  extractKeySignature(parsed) {
    if (!this.options.includeKeySignature) {
      return null;
    }

    // MIDI key signatures are stored in meta events
    // Format: number of sharps/flats (negative for flats), major/minor flag
    let keySignature = null;
    let earliestTime = Infinity;

    // Check header for key signature events
    if (parsed.header && parsed.header.keySignatures && parsed.header.keySignatures.length > 0) {
      const ks = parsed.header.keySignatures[0];
      keySignature = this.midiKeySignatureToString(ks.key, ks.scale);
    }

    // Check all tracks for key signature meta events
    for (const track of parsed.tracks) {
      if (track.meta) {
        for (const meta of track.meta) {
          if (meta.type === 'keySignature' && meta.time < earliestTime) {
            // Use the earliest key signature found
            earliestTime = meta.time;
            keySignature = this.midiKeySignatureToString(meta.key, meta.scale);
          }
        }
      }

      // Also check keySignatures array if present (Tone.js format)
      if (track.keySignatures && track.keySignatures.length > 0) {
        const ks = track.keySignatures[0];
        if (ks.ticks < earliestTime) {
          earliestTime = ks.ticks;
          keySignature = this.midiKeySignatureToString(ks.key, ks.scale);
        }
      }
    }

    return keySignature;
  }

  /**
   * Convert MIDI key signature to string representation
   * @param {number} key - Number of sharps (positive) or flats (negative)
   * @param {string|number} scale - 'major'/'minor' or 0/1 (0=major, 1=minor)
   * @returns {string} Key signature like "C", "G", "Dm"
   */
  midiKeySignatureToString(key, scale) {
    // Normalize scale to boolean (true = minor)
    const isMinor = scale === 'minor' || scale === 1 || scale === true;

    // Map for major keys
    const majorKeys = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#',  // Sharps
                       'C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb']; // Flats

    // Map for minor keys (relative minors)
    const minorKeys = ['A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#',  // Sharps
                       'A', 'D', 'G', 'C', 'F', 'Bb', 'Eb', 'Ab'];   // Flats

    let keyName;

    if (key >= 0) {
      // Sharps (positive numbers)
      const index = Math.min(key, 7);
      keyName = isMinor ? minorKeys[index] : majorKeys[index];
    } else {
      // Flats (negative numbers)
      const index = Math.min(Math.abs(key), 7);
      keyName = isMinor ? minorKeys[8 + index] : majorKeys[8 + index];
    }

    // Add 'm' suffix for minor keys
    return isMinor ? `${keyName}m` : keyName;
  }

  /**
   * Extract metadata from MIDI
   * @param {Object} parsed - Parsed MIDI
   * @returns {Object} Metadata object
   */
  extractMetadata(parsed) {
    const metadata = {};

    // Look for text events in tracks that might contain metadata
    for (const track of parsed.tracks) {
      if (track.meta) {
        for (const meta of track.meta) {
          switch (meta.type) {
            case "trackName":
            case "text":
              if (!metadata.title && meta.text && meta.text.trim()) {
                metadata.title = meta.text.trim();
              }
              break;
            case "copyright":
              if (meta.text && meta.text.trim()) {
                metadata.copyright = meta.text.trim();
              }
              break;
            case "composer":
              if (meta.text && meta.text.trim()) {
                metadata.composer = meta.text.trim();
              }
              break;
          }
        }
      }
    }

    return metadata;
  }

  /**
   * Check if MIDI has tempo changes
   * @param {Object} parsed - Parsed MIDI
   * @returns {boolean} True if has tempo changes
   */
  hasTempoChanges(parsed) {
    if (
      parsed.header && parsed.header.tempos && parsed.header.tempos.length > 1
    ) {
      return true;
    }

    for (const track of parsed.tracks) {
      if (track.tempoEvents && track.tempoEvents.length > 1) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract tempo map for tempo changes
   * @param {Object} parsed - Parsed MIDI
   * @returns {Array} Tempo map events
   */
  extractTempoMap(parsed) {
    const tempoMap = [];

    // Collect all tempo events
    const allTempoEvents = [];

    if (parsed.header && parsed.header.tempos) {
      allTempoEvents.push(...parsed.header.tempos.map((t) => ({
        time: t.time,
        tempo: Math.round(t.bpm),
      })));
    }

    for (const track of parsed.tracks) {
      if (track.tempoEvents) {
        allTempoEvents.push(...track.tempoEvents.map((t) => ({
          time: t.time,
          tempo: Math.round(t.bpm),
        })));
      }
    }

    allTempoEvents.sort((a, b) => a.time - b.time);

    // The built-in parser already reports quarter notes, which is what JMON
    // stores, so those pass straight through. An injected @tonejs/midi
    // reports seconds and has to be converted — and each event has to be
    // converted at the rate in force *before* it, not at its own new rate.
    const inBeats = (parsed?.timeUnit || "seconds") === "beats";
    let previousTempo = allTempoEvents[0]?.tempo || 120;

    for (const event of allTempoEvents) {
      tempoMap.push({
        time: inBeats
          ? event.time
          : this.convertSecondsToQuarterNotes(event.time, previousTempo),
        tempo: event.tempo,
      });
      previousTempo = event.tempo;
    }

    return tempoMap;
  }

  /**
   * Check if MIDI has time signature changes
   * @param {Object} parsed - Parsed MIDI
   * @returns {boolean} True if has time signature changes
   */
  hasTimeSignatureChanges(parsed) {
    if (
      parsed.header && parsed.header.timeSignatures &&
      parsed.header.timeSignatures.length > 1
    ) {
      return true;
    }

    for (const track of parsed.tracks) {
      if (track.timeSignatureEvents && track.timeSignatureEvents.length > 1) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract time signature map for time signature changes
   * @param {Object} parsed - Parsed MIDI
   * @returns {Array} Time signature map events
   */
  extractTimeSignatureMap(parsed) {
    const timeSignatureMap = [];

    // Similar to tempo map extraction
    const allTSEvents = [];

    if (parsed.header && parsed.header.timeSignatures) {
      allTSEvents.push(...parsed.header.timeSignatures);
    }

    for (const track of parsed.tracks) {
      if (track.timeSignatureEvents) {
        allTSEvents.push(...track.timeSignatureEvents);
      }
    }

    allTSEvents.sort((a, b) => a.time - b.time);

    for (const event of allTSEvents) {
      timeSignatureMap.push({
        time: this.convertSecondsToQuarterNotes(event.time, 120), // Use default tempo for conversion
        timeSignature: `${event.numerator}/${event.denominator}`,
      });
    }

    return timeSignatureMap;
  }

  /**
   * Convert seconds to quarter notes
   * @param {number} seconds - Time in seconds
   * @param {number} bpm - Beats per minute
   * @returns {number} Time in quarter notes
   */
  convertSecondsToQuarterNotes(seconds, bpm) {
    const quarterNoteLength = 60 / bpm; // Length of one quarter note in seconds
    return seconds / quarterNoteLength;
  }

  /**
   * Convert duration to note value string
   * @param {number} duration - Duration in seconds
   * @returns {string} Note value like "4n", "8n"
   */
  convertDurationToNoteValue(duration) {
    // Common durations in seconds at 120 BPM
    const quarterNote = 0.5; // 60/120 = 0.5 seconds per quarter note at 120 BPM
    const ratio = duration / quarterNote;

    // Map to common note values
    if (ratio >= 3.5) return "1n"; // Whole note
    if (ratio >= 1.75) return "2n"; // Half note
    if (ratio >= 0.875) return "4n"; // Quarter note
    if (ratio >= 0.4375) return "8n"; // Eighth note
    if (ratio >= 0.21875) return "16n"; // Sixteenth note
    if (ratio >= 0.109375) return "32n"; // Thirty-second note

    return "16n"; // Default to sixteenth note
  }

  /**
   * Extract modulations from MIDI control changes
   * @param {Object} controlChanges - MIDI CC events
   * @returns {Array} Modulation events
   */
  extractModulations(controlChanges) {
    const modulations = [];

    // Convert common MIDI CCs to JMON modulations
    for (const [cc, events] of Object.entries(controlChanges)) {
      const ccNumber = parseInt(cc);

      for (const event of events) {
        const modulation = {
          type: "cc",
          controller: ccNumber,
          value: event.value,
          time: this.convertSecondsToQuarterNotes(event.time, 120),
        };

        modulations.push(modulation);
      }
    }

    return modulations;
  }

  /**
   * Convert note-level modulations
   * @param {Object} controlChanges - Note-level CC events
   * @returns {Array} Note modulation events
   */
  convertNoteModulations(controlChanges) {
    // Similar to extractModulations but for note-level events
    return this.extractModulations(controlChanges);
  }

  /**
   * Apply modulations to track
   * @param {Object} track - JMON track
   * @param {Array} modulations - Modulation events
   */
  applyModulationsToTrack(track, modulations) {
    // For now, add as track-level automation
    // In the future, this could be more sophisticated
    if (modulations.length > 0) {
      track.automation = [{
        id: "midi_cc",
        target: "midi.cc1", // Default to modulation wheel
        anchorPoints: modulations.map((mod) => ({
          time: mod.time,
          value: mod.value,
        })),
      }];
    }
  }

  /**
   * Quantize notes to grid
   * @param {Array} notes - Notes to quantize
   * @param {number} grid - Grid size in quarter notes
   * @returns {Array} Quantized notes
   */
  quantizeNotes(notes, grid) {
    return notes.map((note) => ({
      ...note,
      time: Math.round(note.time / grid) * grid,
    }));
  }
}

/**
 * Export function following existing converter pattern
 * @param {ArrayBuffer|Uint8Array} midiData - MIDI file data
 * @param {Object} options - Conversion options
 * @returns {Promise<Object>} JMON composition
 */
export async function midiToJmon(midiData, options = {}) {
  const isArrayBuffer =
    typeof ArrayBuffer !== 'undefined' && midiData instanceof ArrayBuffer;
  const isUint8Array =
    typeof Uint8Array !== 'undefined' && midiData instanceof Uint8Array;

  if (!isArrayBuffer && !isUint8Array) {
    throw new TypeError("midiToJmon: 'midiData' must be an ArrayBuffer or Uint8Array");
  }

  return await MidiToJmon.convert(midiData, options);
}
