import {
  tempoSegments,
  timeSignatureSegments,
  readTime,
  parseKeySignature as readKeySignature,
} from "./format/timeline.js";
/**
 * Verovio (MusicXML) Converter
 * Converts JMON pieces to MusicXML format for use with Verovio.
 */

/**
 * Convert JMON piece to MusicXML string
 *
 * @param {Object} piece - The JMON piece
 * @returns {string} MusicXML string
 */
export function musicxml(piece) {
  const title = piece.title || piece.metadata?.title || 'Untitled';
  const tempo = piece.tempo || 120;
  const timeSignature = piece.timeSignature || '4/4';
  const keySignature = piece.keySignature || 'C';
  const tracks = piece.tracks || [];

  // Parse time signature
  const [beatsPerMeasure, beatValue] = timeSignature.split('/').map(Number);
  const measureDuration = beatsPerMeasure * (4 / beatValue); // in quarter notes

  // Parse key signature
  const { fifths, mode } = parseKeySignature(keySignature);

  // Filter valid tracks
  const validTracks = tracks.filter(t => t?.notes?.length);
  if (validTracks.length === 0) {
    return createEmptyMusicXML(title, tempo, beatsPerMeasure, beatValue, fifths, mode);
  }

  // Add time to notes if missing (JMON notes are sequential)
  const tracksWithTime = validTracks.map(track => {
    let currentTime = 0;
    const notesWithTime = track.notes.map(note => {
      const noteWithTime = { ...note, time: note.time !== undefined ? note.time : currentTime };
      currentTime += (note.duration || 1);
      return noteWithTime;
    });
    return { ...track, notes: notesWithTime };
  });

  // Quantize note times and durations to the notation grid (sixteenth notes = 0.25 beats).
  // Corrupted or humanized music has fractional beat positions that can't be notated exactly,
  // so we snap to the nearest grid point for a readable score.
  const gridSize = 0.25; // sixteenth note (matches divisions=4)
  const quantizedTracks = tracksWithTime.map(track => ({
    ...track,
    notes: track.notes.map(note => ({
      ...note,
      time: Math.round((note.time || 0) / gridSize) * gridSize,
      duration: Math.max(gridSize, Math.round((note.duration || 1) / gridSize) * gridSize)
    }))
  }));

  // Calculate total duration
  const totalDuration = quantizedTracks.reduce((maxDur, track) => {
    const trackEnd = track.notes.reduce((max, note) => {
      return Math.max(max, (note.time || 0) + (note.duration || 1));
    }, 0);
    return Math.max(maxDur, trackEnd);
  }, 0);

  // Split tracks into measures
  const trackMeasures = quantizedTracks.map(track => {
    return splitIntoMeasures(track.notes, measureDuration, totalDuration);
  });

  // Mid-score changes, indexed by the beat they land on. JMON declares these
  // as maps at piece level; the score is where a reader actually sees
  // them, so they are emitted into the measure whose start they fall on.
  const changes = buildScoreChanges(piece, measureDuration);

  // Generate MusicXML
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n';
  xml += '<score-partwise version="3.1">\n';

  // Work title
  xml += '  <work>\n';
  xml += `    <work-title>${escapeXML(title)}</work-title>\n`;
  xml += '  </work>\n';

  // Part list
  xml += '  <part-list>\n';
  validTracks.forEach((track, index) => {
    const partId = `P${index + 1}`;
    const partName = track.label || `Track ${index + 1}`;
    xml += `    <score-part id="${partId}">\n`;
    xml += `      <part-name>${escapeXML(partName)}</part-name>\n`;
    xml += '    </score-part>\n';
  });
  xml += '  </part-list>\n';

  // Parts
  validTracks.forEach((track, trackIndex) => {
    const partId = `P${trackIndex + 1}`;
    const clef = track.clef || 'treble';
    const measures = trackMeasures[trackIndex];


    xml += `  <part id="${partId}">\n`;

    measures.forEach((measure, measureIndex) => {
      const measureNumber = measureIndex + 1;
      xml += `    <measure number="${measureNumber}">\n`;

      // Mid-score changes. The first measure already carries the opening
      // key, metre and tempo in its <attributes>, so it is skipped here.
      if (measureIndex > 0) {
        xml += midScoreAttributes(measureIndex, measureDuration, changes);
        xml += midScoreTempo(measureIndex, measureDuration, changes);
      }
      xml += annotationsAt(measureIndex, measureDuration, changes);

      // First measure: add attributes
      if (measureIndex === 0) {
        xml += '      <attributes>\n';
        xml += '        <divisions>4</divisions>\n'; // 4 divisions per quarter note
        xml += `        <key>\n`;
        xml += `          <fifths>${fifths}</fifths>\n`;
        xml += `          <mode>${mode}</mode>\n`;
        xml += `        </key>\n`;
        xml += `        <time>\n`;
        xml += `          <beats>${beatsPerMeasure}</beats>\n`;
        xml += `          <beat-type>${beatValue}</beat-type>\n`;
        xml += `        </time>\n`;
        xml += `        <clef>\n`;
        xml += `          <sign>${getClefSign(clef)}</sign>\n`;
        xml += `          <line>${getClefLine(clef)}</line>\n`;
        xml += `        </clef>\n`;
        xml += '      </attributes>\n';

        // Tempo in first measure
        xml += '      <direction placement="above">\n';
        xml += '        <direction-type>\n';
        xml += '          <metronome>\n';
        xml += '            <beat-unit>quarter</beat-unit>\n';
        xml += `            <per-minute>${tempo}</per-minute>\n`;
        xml += '          </metronome>\n';
        xml += '        </direction-type>\n';
        xml += `        <sound tempo="${tempo}"/>\n`;
        xml += '      </direction>\n';
      }

      // Notes in measure — detect simultaneous notes as chords
      measure.forEach((note, noteIdx) => {
        if (note.isRest) {
          xml += '      <note>\n';
          xml += '        <rest/>\n';
          xml += `        <duration>${Math.round(note.duration * 4)}</duration>\n`;
          xml += `        <type>${getDurationType(note.duration)}</type>\n`;
          xml += '      </note>\n';
        } else if (Array.isArray(note.pitch)) {
          // Chord (explicit pitch array)
          const isChordContinuation = noteIdx > 0 && !measure[noteIdx - 1].isRest &&
            timeEqual(note.time, measure[noteIdx - 1].time);
          note.pitch.forEach((p, i) => {
            xml += '      <note>\n';
            if (i > 0 || isChordContinuation) {
              xml += '        <chord/>\n';
            }
            const { step, alter, octave } = midiToPitch(p);
            xml += '        <pitch>\n';
            xml += `          <step>${step}</step>\n`;
            if (alter !== 0) {
              xml += `          <alter>${alter}</alter>\n`;
            }
            xml += `          <octave>${octave}</octave>\n`;
            xml += '        </pitch>\n';
            xml += `        <duration>${Math.round(note.duration * 4)}</duration>\n`;
            xml += `        <type>${getDurationType(note.duration)}</type>\n`;
            xml += '      </note>\n';
          });
        } else {
          // Single note — check if it shares time with the previous note (chord)
          const isChordContinuation = noteIdx > 0 && !measure[noteIdx - 1].isRest &&
            timeEqual(note.time, measure[noteIdx - 1].time);
          xml += '      <note>\n';
          if (isChordContinuation) {
            xml += '        <chord/>\n';
          }
          const { step, alter, octave } = midiToPitch(note.pitch);
          xml += '        <pitch>\n';
          xml += `          <step>${step}</step>\n`;
          if (alter !== 0) {
            xml += `          <alter>${alter}</alter>\n`;
          }
          xml += `          <octave>${octave}</octave>\n`;
          xml += '        </pitch>\n';
          xml += `        <duration>${Math.round(note.duration * 4)}</duration>\n`;
          xml += `        <type>${getDurationType(note.duration)}</type>\n`;
          xml += '      </note>\n';
        }
      });

      xml += '    </measure>\n';
    });

    xml += '  </part>\n';
  });

  xml += '</score-partwise>\n';

  return xml;
}

/**
 * Download a JMON piece as a MusicXML file
 *
 * @param {Object} piece - The JMON piece
 * @param {string} [filename='piece.musicxml'] - Output filename
 */
export function downloadMusicXML(piece, filename = 'piece.musicxml') {
  const xml = musicxml(piece);
  const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Helper functions ---

/**
 * Normalize time values to avoid floating point precision errors
 */
function normalizeTime(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Check if two time values are approximately equal
 */
function timeEqual(a, b, tolerance = 0.0001) {
  return Math.abs(a - b) < tolerance;
}

/**
 * Split notes into measures
 */
function splitIntoMeasures(notes, measureDuration, totalDuration) {
  const measures = [];
  let currentMeasure = [];

  // Sort notes by time
  const sortedNotes = [...notes].sort((a, b) => (a.time || 0) - (b.time || 0));

  // Normalize all note times and durations
  const normalizedNotes = sortedNotes.map(note => ({
    ...note,
    time: normalizeTime(note.time || 0),
    duration: normalizeTime(note.duration || 1)
  }));

  let noteIndex = 0;
  const numMeasures = Math.ceil(normalizeTime(totalDuration) / measureDuration);

  for (let measureNum = 0; measureNum < numMeasures; measureNum++) {
    const measureStart = normalizeTime(measureNum * measureDuration);
    const measureEnd = normalizeTime(measureStart + measureDuration);
    currentMeasure = [];

    // Fill measure with notes/rests
    let measureTime = measureStart;

    while (noteIndex < normalizedNotes.length && normalizedNotes[noteIndex].time < measureEnd) {
      const note = normalizedNotes[noteIndex];

      // Add rest if there's a gap
      if (note.time > measureTime && !timeEqual(note.time, measureTime)) {
        const restDuration = normalizeTime(note.time - measureTime);
        if (restDuration > 0.0001) {
          currentMeasure.push({ isRest: true, duration: restDuration });
        }
        measureTime = note.time;
      }

      const noteEnd = normalizeTime(note.time + note.duration);

      // Note fits entirely in this measure
      if (noteEnd <= measureEnd || timeEqual(noteEnd, measureEnd)) {
        currentMeasure.push({ ...note, duration: note.duration });
        measureTime = noteEnd;
        noteIndex++;
      }
      // Note extends into next measure - split it
      else {
        const durationInMeasure = normalizeTime(measureEnd - measureTime);
        if (durationInMeasure > 0.0001) {
          currentMeasure.push({ ...note, duration: durationInMeasure });
        }

        // Update note for next measure (tied note)
        normalizedNotes[noteIndex] = {
          ...note,
          time: measureEnd,
          duration: normalizeTime(note.duration - durationInMeasure)
        };
        measureTime = measureEnd;
        break; // Move to next measure
      }
    }

    // Fill rest of measure with rest if needed
    if (measureTime < measureEnd && !timeEqual(measureTime, measureEnd)) {
      const restDuration = normalizeTime(measureEnd - measureTime);
      if (restDuration > 0.0001) {
        currentMeasure.push({ isRest: true, duration: restDuration });
      }
    }

    // Only add non-empty measures
    if (currentMeasure.length > 0) {
      measures.push(currentMeasure);
    }
  }

  return measures;
}

/**
 * Convert MIDI pitch to MusicXML pitch
 */
function midiToPitch(midi) {
  if (typeof midi !== 'number') return { step: 'C', alter: 0, octave: 4 };

  const pitchClass = midi % 12;
  const octave = Math.floor(midi / 12) - 1;

  const pitchMap = {
    0: { step: 'C', alter: 0 },
    1: { step: 'C', alter: 1 },
    2: { step: 'D', alter: 0 },
    3: { step: 'E', alter: -1 },
    4: { step: 'E', alter: 0 },
    5: { step: 'F', alter: 0 },
    6: { step: 'F', alter: 1 },
    7: { step: 'G', alter: 0 },
    8: { step: 'G', alter: 1 },
    9: { step: 'A', alter: 0 },
    10: { step: 'B', alter: -1 },
    11: { step: 'B', alter: 0 }
  };

  return { ...pitchMap[pitchClass], octave };
}

/**
 * Get MusicXML duration type from quarter note duration
 */
function getDurationType(duration) {
  if (duration >= 4) return 'whole';
  if (duration >= 2) return 'half';
  if (duration >= 1) return 'quarter';
  if (duration >= 0.5) return 'eighth';
  if (duration >= 0.25) return '16th';
  return '32nd';
}

/**
 * Parse a key signature into MusicXML's `<fifths>` and `<mode>`.
 *
 * This used to keep its own major-only table, so every minor key was written
 * with its parallel major's accidentals — A minor came out with three sharps.
 * The shared reader knows that a minor key takes its *relative* major's.
 */
function parseKeySignature(keySignature) {
  const { sharps, minor } = readKeySignature(keySignature);
  return { fifths: sharps, mode: minor ? 'minor' : 'major' };
}

/**
 * Get clef sign from clef name
 */
function getClefSign(clef) {
  const clefMap = {
    'treble': 'G',
    'bass': 'F',
    'alto': 'C',
    'tenor': 'C',
    'percussion': 'percussion'
  };
  return clefMap[clef] || 'G';
}

/**
 * Get clef line from clef name
 */
function getClefLine(clef) {
  const lineMap = {
    'treble': 2,
    'bass': 4,
    'alto': 3,
    'tenor': 4,
    'percussion': 3
  };
  return lineMap[clef] || 2;
}

/**
 * Escape XML special characters
 */
function escapeXML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Create empty MusicXML document
 */
function createEmptyMusicXML(title, tempo, beatsPerMeasure, beatValue, fifths, mode) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n';
  xml += '<score-partwise version="3.1">\n';
  xml += '  <work>\n';
  xml += `    <work-title>${escapeXML(title)}</work-title>\n`;
  xml += '  </work>\n';
  xml += '  <part-list>\n';
  xml += '    <score-part id="P1">\n';
  xml += '      <part-name>Music</part-name>\n';
  xml += '    </score-part>\n';
  xml += '  </part-list>\n';
  xml += '  <part id="P1">\n';
  xml += '    <measure number="1">\n';
  xml += '      <attributes>\n';
  xml += '        <divisions>4</divisions>\n';
  xml += '        <key>\n';
  xml += `          <fifths>${fifths}</fifths>\n`;
  xml += `          <mode>${mode}</mode>\n`;
  xml += '        </key>\n';
  xml += '        <time>\n';
  xml += `          <beats>${beatsPerMeasure}</beats>\n`;
  xml += `          <beat-type>${beatValue}</beat-type>\n`;
  xml += '        </time>\n';
  xml += '        <clef>\n';
  xml += '          <sign>G</sign>\n';
  xml += '          <line>2</line>\n';
  xml += '        </clef>\n';
  xml += '      </attributes>\n';
  xml += '      <note>\n';
  xml += '        <rest/>\n';
  xml += '        <duration>16</duration>\n';
  xml += '        <type>whole</type>\n';
  xml += '      </note>\n';
  xml += '    </measure>\n';
  xml += '  </part>\n';
  xml += '</score-partwise>\n';
  return xml;
}

/**
 * Collect the piece's mid-score changes into per-beat buckets.
 *
 * `keySignatureMap`, `timeSignatureMap`, `tempoMap` and `annotations` all say
 * "at this beat, something changes". They are gathered once here so the
 * measure loop can ask a single question per measure.
 */
function buildScoreChanges(piece, measureDuration) {
  const beatsPerBar = measureDuration;
  const at = (time) => readTime(time, beatsPerBar);

  const keys = (piece.keySignatureMap || [])
    .filter((entry) => entry && entry.keySignature)
    .map((entry) => ({ beat: at(entry.time), keySignature: entry.keySignature }));

  // The opening entries are already in the first measure's <attributes>.
  const meters = timeSignatureSegments(piece).filter((s) => s.time > 0);
  const tempos = tempoSegments(piece).filter((s) => s.time > 0);

  const annotations = (piece.annotations || [])
    .filter((entry) => entry && (entry.text || entry.label))
    .map((entry) => ({
      beat: at(entry.time),
      text: String(entry.text ?? entry.label),
      type: entry.type || "text",
    }));

  return { keys, meters, tempos, annotations };
}

/** Anything landing inside the measure that starts at `measureIndex`. */
function within(items, measureIndex, measureDuration, key = "beat") {
  const start = measureIndex * measureDuration;
  const end = start + measureDuration;
  return items.filter((item) => {
    const beat = item[key] ?? item.time;
    return beat >= start && beat < end;
  });
}

/** `<attributes>` for a key or metre change at this measure. */
function midScoreAttributes(measureIndex, measureDuration, changes) {
  const keys = within(changes.keys, measureIndex, measureDuration);
  const meters = within(changes.meters, measureIndex, measureDuration, "time");
  if (keys.length === 0 && meters.length === 0) return "";

  let xml = "      <attributes>\n";
  if (keys.length > 0) {
    const { fifths, mode } = parseKeySignature(keys.at(-1).keySignature);
    xml += "        <key>\n";
    xml += `          <fifths>${fifths}</fifths>\n`;
    xml += `          <mode>${mode}</mode>\n`;
    xml += "        </key>\n";
  }
  if (meters.length > 0) {
    const meter = meters.at(-1);
    xml += "        <time>\n";
    xml += `          <beats>${meter.numerator}</beats>\n`;
    xml += `          <beat-type>${meter.denominator}</beat-type>\n`;
    xml += "        </time>\n";
  }
  xml += "      </attributes>\n";
  return xml;
}

/** A metronome mark for a tempo change at this measure. */
function midScoreTempo(measureIndex, measureDuration, changes) {
  const tempos = within(changes.tempos, measureIndex, measureDuration, "time");
  if (tempos.length === 0) return "";

  const tempo = tempos.at(-1).tempo;
  let xml = '      <direction placement="above">\n';
  xml += "        <direction-type>\n";
  xml += "          <metronome>\n";
  xml += "            <beat-unit>quarter</beat-unit>\n";
  xml += `            <per-minute>${Math.round(tempo)}</per-minute>\n`;
  xml += "          </metronome>\n";
  xml += "        </direction-type>\n";
  xml += `        <sound tempo="${Math.round(tempo)}"/>\n`;
  xml += "      </direction>\n";
  return xml;
}

/** Free text — rehearsal marks, expression marks — placed above the staff. */
function annotationsAt(measureIndex, measureDuration, changes) {
  const items = within(changes.annotations, measureIndex, measureDuration);
  if (items.length === 0) return "";

  let xml = "";
  for (const item of items) {
    const tag = item.type === "rehearsal" ? "rehearsal" : "words";
    xml += '      <direction placement="above">\n';
    xml += "        <direction-type>\n";
    xml += `          <${tag}>${escapeXML(item.text)}</${tag}>\n`;
    xml += "        </direction-type>\n";
    xml += "      </direction>\n";
  }
  return xml;
}
