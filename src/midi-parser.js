/**
 * Standard MIDI File parser.
 *
 * Self-contained: no Tone.js, no @tonejs/midi, no dependency at all. It exists
 * so `midiToJmon` can run anywhere `jmon/algo` runs — a MIDI file is bytes, and
 * reading it should not require an audio library.
 *
 * Times are emitted in **quarter notes**, not seconds. Ticks divided by the
 * file's PPQ give beats directly, which is what JMON stores, and it sidesteps
 * having to know the tempo to place a note.
 *
 * Output shape (compatible with what `@tonejs/midi` exposes, so the conversion
 * layer above it is unchanged):
 *
 *   {
 *     header: { ppq, name, tempos: [{ time, bpm }],
 *               timeSignatures: [{ time, numerator, denominator }],
 *               keySignatures: [{ time, key, scale }] },
 *     tracks: [{ channel, name, instrument: { number, name },
 *                notes: [{ midi, time, duration, velocity }],
 *                controlChanges: { [cc]: [{ number, value, time }] } }],
 *     timeUnit: "beats"
 *   }
 */

const HEADER_CHUNK = 0x4d546864; // "MThd"
const TRACK_CHUNK = 0x4d54726b; // "MTrk"

/** Sequential byte reader over a Uint8Array. */
class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  get done() {
    return this.pos >= this.bytes.length;
  }

  uint8() {
    if (this.pos >= this.bytes.length) {
      throw new Error("Unexpected end of MIDI data");
    }
    return this.bytes[this.pos++];
  }

  uint16() {
    return (this.uint8() << 8) | this.uint8();
  }

  uint32() {
    return ((this.uint8() << 24) | (this.uint8() << 16) |
      (this.uint8() << 8) | this.uint8()) >>> 0;
  }

  /** Variable-length quantity: 7 bits per byte, high bit continues. */
  varint() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.uint8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("Malformed variable-length quantity in MIDI data");
  }

  slice(length) {
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  string(length) {
    let out = "";
    for (const byte of this.slice(length)) out += String.fromCharCode(byte);
    return out;
  }
}

/** Coerce whatever the caller passed into a Uint8Array. */
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) return Uint8Array.from(data);
  throw new Error(
    "parseMidiFile expects a Uint8Array, ArrayBuffer, typed array or byte array",
  );
}

const GM_DRUM_CHANNEL = 9;

/**
 * Parse a Standard MIDI File.
 *
 * @param {Uint8Array|ArrayBuffer|Array<number>} data - The file's bytes
 * @returns {Object} Parsed MIDI, with all times in quarter notes
 */
export function parseMidiFile(data) {
  const reader = new Reader(toBytes(data));

  if (reader.uint32() !== HEADER_CHUNK) {
    throw new Error("Not a Standard MIDI File: missing MThd header");
  }
  const headerLength = reader.uint32();
  const format = reader.uint16();
  const trackCount = reader.uint16();
  const division = reader.uint16();
  // Skip any header bytes beyond the standard six.
  reader.slice(Math.max(0, headerLength - 6));

  if (division & 0x8000) {
    throw new Error(
      "SMPTE-timed MIDI files are not supported; expected a ticks-per-quarter division",
    );
  }
  const ppq = division || 480;

  const header = {
    ppq,
    format,
    name: "",
    tempos: [],
    timeSignatures: [],
    keySignatures: [],
  };
  const tracks = [];

  for (let i = 0; i < trackCount && !reader.done; i++) {
    if (reader.uint32() !== TRACK_CHUNK) {
      // Unknown chunk type — the spec says skip it.
      const length = reader.uint32();
      reader.slice(length);
      i--;
      continue;
    }
    const length = reader.uint32();
    const track = readTrack(new Reader(reader.slice(length)), ppq, header);
    tracks.push(track);
  }

  if (header.tempos.length === 0) header.tempos.push({ time: 0, bpm: 120 });
  if (header.timeSignatures.length === 0) {
    header.timeSignatures.push({ time: 0, numerator: 4, denominator: 4 });
  }

  return { header, tracks, timeUnit: "beats" };
}

/**
 * Read one MTrk chunk. Meta events that describe the whole piece (tempo, time
 * and key signature) are collected onto the shared header, as they are in a
 * format-1 file where track 0 carries them alone.
 */
function readTrack(reader, ppq, header) {
  const track = {
    name: "",
    channel: undefined,
    instrument: undefined,
    notes: [],
    controlChanges: {},
    pitchBends: [],
    // Pitch bend is meaningless without knowing its span. RPN 0 carries it;
    // 2 semitones is the standard default when a file does not say.
    pitchBendRange: 2,
  };

  // Sounding notes keyed by `channel:pitch`, awaiting their note-off.
  const pending = new Map();
  let ticks = 0;
  let runningStatus = 0;
  const rpn = { msb: null, lsb: null };

  while (!reader.done) {
    ticks += reader.varint();
    const beats = ticks / ppq;

    let status = reader.uint8();
    if ((status & 0x80) === 0) {
      // Running status: this byte is data, reuse the previous status byte.
      reader.pos--;
      status = runningStatus;
    } else {
      runningStatus = status;
    }

    if (status === 0xff) {
      readMetaEvent(reader, beats, track, header);
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      reader.slice(reader.varint()); // sysex — not represented in JMON
      continue;
    }

    const type = status & 0xf0;
    const channel = status & 0x0f;
    if (track.channel === undefined) track.channel = channel;

    switch (type) {
      case 0x90: { // note on
        const pitch = reader.uint8();
        const velocity = reader.uint8();
        if (velocity === 0) {
          closeNote(track, pending, channel, pitch, beats);
        } else {
          pending.set(`${channel}:${pitch}`, { beats, velocity: velocity / 127 });
        }
        break;
      }
      case 0x80: { // note off
        const pitch = reader.uint8();
        reader.uint8(); // release velocity, unused
        closeNote(track, pending, channel, pitch, beats);
        break;
      }
      case 0xb0: { // control change
        const number = reader.uint8();
        const value = reader.uint8();

        // RPN 0 is pitch bend sensitivity. Track it so a bend can be read
        // back in semitones rather than as an opaque ratio.
        if (number === 101) rpn.msb = value;
        else if (number === 100) rpn.lsb = value;
        else if (number === 6 && rpn.msb === 0 && rpn.lsb === 0) {
          track.pitchBendRange = value || 2;
        }

        (track.controlChanges[number] ||= []).push({
          number,
          value: value / 127,
          time: beats,
        });
        break;
      }
      case 0xc0: { // program change
        const program = reader.uint8();
        track.instrument = { number: program, name: `program ${program}` };
        break;
      }
      case 0xd0: // channel pressure
        reader.uint8();
        break;
      case 0xa0: // polyphonic aftertouch
        reader.uint8();
        reader.uint8();
        break;
      case 0xe0: { // pitch bend — 14 bit, little end first, 8192 at rest
        const lsb = reader.uint8();
        const msb = reader.uint8();
        const raw = (msb << 7) | lsb;
        track.pitchBends.push({ time: beats, value: (raw - 8192) / 8192 });
        break;
      }
      default:
        // Unknown status: without a length we cannot skip safely.
        throw new Error(`Unrecognised MIDI status byte 0x${status.toString(16)}`);
    }
  }

  // A note still sounding at the end of the track gets a zero-length tail
  // rather than being dropped.
  for (const [key, start] of pending) {
    const pitch = Number(key.split(":")[1]);
    track.notes.push({
      midi: pitch,
      time: start.beats,
      duration: 0,
      velocity: start.velocity,
    });
  }

  track.notes.sort((a, b) => a.time - b.time || a.midi - b.midi);

  if (!track.instrument) {
    track.instrument = track.channel === GM_DRUM_CHANNEL
      ? { number: 0, name: "drums" }
      : { number: 0, name: "program 0" };
  }

  return track;
}

function closeNote(track, pending, channel, pitch, beats) {
  const key = `${channel}:${pitch}`;
  const start = pending.get(key);
  if (!start) return; // note-off with no matching note-on
  pending.delete(key);
  track.notes.push({
    midi: pitch,
    time: start.beats,
    duration: Math.max(0, beats - start.beats),
    velocity: start.velocity,
  });
}

const KEY_NAMES_MAJOR = [
  "Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F",
  "C", "G", "D", "A", "E", "B", "F#", "C#",
];
const KEY_NAMES_MINOR = [
  "Ab", "Eb", "Bb", "F", "C", "G", "D",
  "A", "E", "B", "F#", "C#", "G#", "D#", "A#",
];

function readMetaEvent(reader, beats, track, header) {
  const metaType = reader.uint8();
  const length = reader.varint();

  switch (metaType) {
    case 0x03: { // track name
      const name = reader.string(length);
      track.name = name;
      if (!header.name) header.name = name;
      break;
    }
    case 0x51: { // set tempo — microseconds per quarter note
      const bytes = reader.slice(length);
      const microseconds = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
      header.tempos.push({ time: beats, bpm: 60000000 / microseconds });
      break;
    }
    case 0x58: { // time signature
      const bytes = reader.slice(length);
      header.timeSignatures.push({
        time: beats,
        numerator: bytes[0],
        denominator: 2 ** bytes[1],
      });
      break;
    }
    case 0x59: { // key signature
      const bytes = reader.slice(length);
      // sf is signed: negative counts flats, positive counts sharps.
      const sharps = (bytes[0] << 24) >> 24;
      const minor = bytes[1] === 1;
      const names = minor ? KEY_NAMES_MINOR : KEY_NAMES_MAJOR;
      header.keySignatures.push({
        time: beats,
        key: names[sharps + 7] ?? "C",
        scale: minor ? "minor" : "major",
      });
      break;
    }
    default:
      reader.slice(length);
  }
}

export default parseMidiFile;
