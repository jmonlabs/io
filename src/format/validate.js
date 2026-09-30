// JMON validator.
//
// Structural, not schema-driven: it checks and repairs the shape a piece
// must have to be played or exported — tracks present, notes well-formed,
// timing numeric — and normalises the shorthand forms (a bare note array, a
// single-track object) into a full piece.
//
// It deliberately does not validate against `schemas/jmon-schema.json`. Doing
// that would mean shipping a JSON Schema validator, and `jmon/algo` is
// dependency-free ESM served straight from source. The schema is the written
// specification; this is the runtime guard.

/**
 * Note fields that changed name in 3.4, to what they are called now. The old
 * spelling is still read everywhere; here it is renamed, with a warning, so a
 * piece written before the change comes out in today's words.
 */
export const RENAMED_NOTE_FIELDS = {
  microtuning: "tuning",
  pitchEnvelope: "bend",
  amplitudeEnvelope: "dynamics",
};

export class JmonValidator {
  constructor() {}

  /**
   * Basic validation and normalization for browser use
   * @param {Object} obj - JMON object to validate
   * @returns {Object} { valid, errors, normalized }
   */
  validateAndNormalize(obj) {
    const errors = [];
    const warnings = [];
    let normalized = { ...obj };

    try {
      // Basic structure validation
      if (!obj || typeof obj !== "object") {
        errors.push("Object must be a valid object");
        return { valid: false, errors, normalized: null };
      }

      // Ensure tracks exist
      if (!normalized.tracks && !normalized.notes) {
        // Try to create a basic track structure
        if (Array.isArray(obj)) {
          normalized = { tracks: [{ notes: obj }] };
        } else {
          normalized.tracks = normalized.tracks || [];
        }
      }

      // Normalize single track to tracks array
      if (normalized.notes && !normalized.tracks) {
        normalized.tracks = [{ notes: normalized.notes }];
        delete normalized.notes;
      }

      // Ensure tracks is an array
      if (!Array.isArray(normalized.tracks)) {
        normalized.tracks = [normalized.tracks];
      }

      // Basic note validation
      normalized.tracks.forEach((track, trackIndex) => {
        if (!track.notes) {
          errors.push(`Track ${trackIndex} missing notes array`);
          return;
        }

        if (!Array.isArray(track.notes)) {
          errors.push(`Track ${trackIndex} notes must be an array`);
          return;
        }

        track.notes.forEach((note, noteIndex) => {
          if (typeof note !== "object") {
            errors.push(
              `Track ${trackIndex}, note ${noteIndex}: must be an object`,
            );
            return;
          }

          // Ensure required properties
          if (note.pitch === undefined) {
            note.pitch = null; // Default to rest
          }
          if (note.duration === undefined) {
            note.duration = 1; // Default to quarter note
          }
          if (note.time === undefined) {
            note.time = 0; // Will be calculated if needed
          }

          for (const [was, is] of Object.entries(RENAMED_NOTE_FIELDS)) {
            if (!(was in note)) continue;
            if (!(is in note)) note[is] = note[was];
            delete note[was];
            if (!warnings.some((w) => w.field === was)) {
              warnings.push({ field: was, why: `\`${was}\` is now \`${is}\`; renamed`, kind: "renamed" });
            }
          }
        });
      });

      // Set basic defaults
      normalized.format = normalized.format || "jmon";
      normalized.version = normalized.version || "1.0";
      normalized.timeSignature = normalized.timeSignature || "4/4";
      normalized.keySignature = normalized.keySignature || "C";

      const result = { valid: errors.length === 0, errors, normalized };
      if (warnings.length > 0) result.warnings = warnings;
      return result;
    } catch (error) {
      errors.push(`Validation error: ${error.message}`);
      return {
        valid: false,
        errors,
        normalized: null,
      };
    }
  }

  /**
   * Simple validation without normalization
   * @param {Object} obj - JMON object to validate
   * @returns {boolean} true if valid
   */
  isValid(obj) {
    const result = this.validateAndNormalize(obj);
    return result.valid;
  }
}
