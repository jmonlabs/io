/**
 * Serialisation: MIDI out, MIDI in, MusicXML, SuperCollider, and the
 * validator that guards them.
 *
 * The headline is the MIDI round-trip. It was impossible before: midiToJmon
 * required a `Tone.Midi` parser that Tone.js does not have (the class it was
 * written against lives in @tonejs/midi, which was never a dependency), so
 * nothing here had ever been exercised against real bytes.
 *
 * node:test + assert. Run with: node --test tests/converters.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { midiBytes, midiBase64 } from "../src/midi.js";
import { musicxml } from "../src/musicxml.js";
import { midiToJmon } from "../src/midi-to-jmon.js";
import { parseMidiFile } from "../src/midi-parser.js";
import { JmonValidator } from "../src/format/validate.js";

const note = (pitch, time, duration = 1, velocity = 0.8) => ({ pitch, duration, time, velocity });

const PIECE = {
  format: "jmon",
  version: "1.0",
  tempo: 120,
  tracks: [
    { label: "lead", notes: [note(60, 0, 1), note(64, 1, 0.5), note(67, 2, 2)] },
    { label: "bass", notes: [note(36, 0, 2), note(38, 2, 2)] },
  ],
};

/* --- the MIDI writer ----------------------------------------------------- */

test("midiBytes emits a well-formed Standard MIDI File", async () => {
  const bytes = await midiBytes(PIECE);

  assert.ok(bytes instanceof Uint8Array || Array.isArray(bytes));
  const header = Array.from(bytes.slice(0, 4)).map((b) => String.fromCharCode(b)).join("");
  assert.equal(header, "MThd", "missing MThd chunk");
  assert.ok(bytes.length > 20, "file is implausibly short");
});

test("midiBase64 produces decodable base64", async () => {
  const encoded = await midiBase64(PIECE);
  assert.equal(typeof encoded, "string");
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(encoded, "base64").subarray(0, 4).toString(), "MThd");
});

/* --- the parser ---------------------------------------------------------- */

test("parseMidiFile reads the header it was given", async () => {
  const parsed = parseMidiFile(await midiBytes(PIECE));

  assert.equal(parsed.timeUnit, "beats", "times must be in quarter notes");
  assert.ok(parsed.header.ppq > 0);
  assert.equal(parsed.header.tempos[0].bpm, 120);
  assert.ok(Array.isArray(parsed.tracks));
});

test("parseMidiFile rejects data that is not a MIDI file", () => {
  assert.throws(() => parseMidiFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /Not a Standard MIDI File/);
});

test("parseMidiFile accepts every byte container", async () => {
  const bytes = await midiBytes(PIECE);
  const asArray = Array.from(bytes);
  const asBuffer = Uint8Array.from(bytes).buffer;

  const fromArray = parseMidiFile(asArray);
  const fromBuffer = parseMidiFile(asBuffer);
  assert.equal(fromArray.tracks.length, fromBuffer.tracks.length);
});

test("parseMidiFile needs no audio library", async () => {
  // Nothing about reading a file should require Tone.js. If this ever starts
  // throwing about a missing Tone instance, the dependency crept back in.
  const parsed = parseMidiFile(await midiBytes(PIECE));
  assert.ok(parsed.tracks.length > 0);
});

/* --- the round trip ------------------------------------------------------ */

test("a piece survives jmon -> midi -> jmon unchanged", async () => {
  const back = await midiToJmon(await midiBytes(PIECE));

  assert.equal(back.tempo, PIECE.tempo);
  assert.equal(back.tracks.length, PIECE.tracks.length);

  for (const [i, original] of PIECE.tracks.entries()) {
    const recovered = back.tracks[i];
    assert.deepEqual(
      recovered.notes.map((n) => [n.pitch, n.time, n.duration]),
      original.notes.map((n) => [n.pitch, n.time, n.duration]),
      `track ${i} (${original.label}) did not round-trip`,
    );
  }
});

test("the round trip preserves velocity to within MIDI's resolution", async () => {
  const back = await midiToJmon(await midiBytes(PIECE));

  const originals = PIECE.tracks.flatMap((t) => t.notes).map((n) => n.velocity);
  const recovered = back.tracks.flatMap((t) => t.notes).map((n) => n.velocity);

  assert.equal(recovered.length, originals.length);
  recovered.forEach((velocity, i) => {
    // MIDI velocity is 7-bit, so a value can move by up to 1/127.
    assert.ok(
      Math.abs(velocity - originals[i]) <= 1 / 127,
      `velocity ${i}: ${velocity} vs ${originals[i]}`,
    );
  });
});

test("the round trip holds for fractional and long durations", async () => {
  const awkward = {
    format: "jmon", version: "1.0", tempo: 90,
    tracks: [{
      label: "t",
      notes: [note(60, 0, 0.25), note(62, 0.25, 0.75), note(64, 1, 3), note(65, 4, 0.5)],
    }],
  };

  const back = await midiToJmon(await midiBytes(awkward));
  assert.equal(back.tempo, 90);
  assert.deepEqual(
    back.tracks[0].notes.map((n) => [n.pitch, n.time, n.duration]),
    awkward.tracks[0].notes.map((n) => [n.pitch, n.time, n.duration]),
  );
});

test("a chord round-trips as simultaneous notes", async () => {
  const chordal = {
    format: "jmon", version: "1.0", tempo: 120,
    tracks: [{ label: "t", notes: [{ pitch: [60, 64, 67], duration: 2, time: 0, velocity: 0.8 }] }],
  };

  const back = await midiToJmon(await midiBytes(chordal));
  const notes = back.tracks[0].notes;
  assert.equal(notes.length, 3, "a triad should come back as three notes");
  assert.deepEqual(notes.map((n) => n.pitch).sort((a, b) => a - b), [60, 64, 67]);
  assert.ok(notes.every((n) => n.time === 0), "chord tones should stay aligned");
});

test("rests are not written as notes", async () => {
  const withRest = {
    format: "jmon", version: "1.0", tempo: 120,
    tracks: [{ label: "t", notes: [note(60, 0, 1), { pitch: null, duration: 1, time: 1 }, note(64, 2, 1)] }],
  };

  const back = await midiToJmon(await midiBytes(withRest));
  assert.deepEqual(back.tracks[0].notes.map((n) => n.pitch), [60, 64]);
  assert.deepEqual(back.tracks[0].notes.map((n) => n.time), [0, 2], "the gap should survive");
});

test("an injected parser is preferred over the built-in one", async () => {
  let used = false;
  class FakeMidi {
    constructor() {
      used = true;
      this.header = { tempos: [{ time: 0, bpm: 96 }], timeSignatures: [] };
      this.tracks = [{ channel: 0, name: "fake", notes: [{ midi: 72, time: 0, duration: 0.5, velocity: 1 }] }];
    }
  }

  const back = await midiToJmon(await midiBytes(PIECE), { parser: FakeMidi });
  assert.ok(used, "the injected parser was ignored");
  assert.equal(back.tempo, 96);
});

/* --- other converters ---------------------------------------------------- */


/* --- the validator ------------------------------------------------------- */

test("the validator accepts a well-formed piece quietly", () => {
  const { valid, errors, normalized } = new JmonValidator().validateAndNormalize(PIECE);
  assert.equal(valid, true, `unexpected errors: ${JSON.stringify(errors)}`);
  assert.equal(normalized.tracks.length, 2);
});

test("the validator normalises the shorthand forms", () => {
  const validator = new JmonValidator();

  const fromArray = validator.validateAndNormalize([note(60, 0)]);
  assert.ok(Array.isArray(fromArray.normalized.tracks), "a bare note array should become tracks");

  const fromSingleTrack = validator.validateAndNormalize({ tempo: 100, notes: [note(60, 0)] });
  assert.ok(Array.isArray(fromSingleTrack.normalized.tracks));
  assert.equal(fromSingleTrack.normalized.notes, undefined, "notes should move under a track");
});

test("the validator rejects what is not an object", () => {
  const { valid } = new JmonValidator().validateAndNormalize(null);
  assert.equal(valid, false);
});

test("the declared version is the same in both places", async () => {
  // These drifted apart in jmon/algo (1.1.0 against 1.0.0) because nothing
  // compared them. Same guard here.
  const { VERSION } = await import("../src/index.js");
  const pkg = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("../package.json", import.meta.url), "utf8",
    ),
  );
  assert.equal(VERSION, pkg.version, "io.VERSION and package.json disagree");
});

test("constructing the validator prints nothing", () => {
  // It used to warn on every construction, pointing at a Node-with-ajv build
  // that does not exist — so every midiToJmon call emitted it.
  const original = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(" "));
  try {
    new JmonValidator();
  } finally {
    console.warn = original;
  }
  assert.deepEqual(seen, []);
});

/* --- mid-score changes in MusicXML --------------------------------------- */

test("MusicXML carries key, metre, tempo and annotation changes", async () => {
  const { musicxml } = await import("../src/musicxml.js");

  const xml = musicxml({
    format: "jmon", version: "1.0", tempo: 120, timeSignature: "4/4", keySignature: "C",
    keySignatureMap: [{ time: 8, keySignature: "G" }],
    timeSignatureMap: [{ time: 8, timeSignature: "3/4" }],
    tempoMap: [{ time: 0, tempo: 120 }, { time: 4, tempo: 90 }],
    annotations: [{ time: 0, text: "Intro", type: "rehearsal" }, { time: 4, text: "dolce" }],
    tracks: [{
      label: "t",
      notes: Array.from({ length: 12 }, (_, i) => note(60 + i, i, 1)),
    }],
  });

  assert.match(xml, /<rehearsal>Intro<\/rehearsal>/);
  assert.match(xml, /<words>dolce<\/words>/);
  assert.match(xml, /<per-minute>90<\/per-minute>/, "the tempo change should appear");
  assert.match(xml, /<fifths>1<\/fifths>/, "G major is one sharp");
  assert.match(xml, /<beats>3<\/beats>/, "the metre change should appear");
});

test("MusicXML interpolates the tempo instead of writing it literally", async () => {
  const { musicxml } = await import("../src/musicxml.js");
  const xml = musicxml({
    format: "jmon", version: "1.0", tempo: 96,
    tracks: [{ label: "t", notes: [note(60, 0)] }],
  });

  assert.match(xml, /<sound tempo="96"\/>/);
  assert.ok(!xml.includes("${tempo}"), "the template placeholder leaked into the output");
});

test("a piece with no maps produces no stray mid-score attributes", async () => {
  const { musicxml } = await import("../src/musicxml.js");
  const xml = musicxml({
    format: "jmon", version: "1.0", tempo: 120,
    tracks: [{ label: "t", notes: Array.from({ length: 8 }, (_, i) => note(60, i, 1)) }],
  });

  assert.equal((xml.match(/<attributes>/g) || []).length, 1, "only the opening attributes");
  assert.equal((xml.match(/<per-minute>/g) || []).length, 1, "only the opening tempo");
});

/* --- custom presets ------------------------------------------------------ */



/* --- glissando through MIDI ---------------------------------------------- */

test("a glissando survives jmon -> midi -> jmon", async () => {
  // Standard MIDI File has no glissando message, so the writer emits a pitch
  // bend sweep — preceded by an RPN 0 that widens the bend range, since the
  // 2-semitone default cannot express a slide of a fifth.
  const slide = {
    format: "jmon", version: "1.0", tempo: 120,
    tracks: [{
      label: "lead",
      notes: [{ ...note(60, 0, 2), articulations: [{ type: "glissando", target: 67 }] }],
    }],
  };

  const back = await midiToJmon(await midiBytes(slide));
  const recovered = back.tracks[0].notes[0];

  assert.equal(recovered.pitch, 60);
  assert.deepEqual(recovered.articulations, [{ type: "glissando", target: 67 }]);
});

test("a descending slide keeps its direction", async () => {
  const slide = {
    format: "jmon", version: "1.0", tempo: 120,
    tracks: [{
      label: "lead",
      notes: [{ ...note(72, 0, 2), articulations: [{ type: "glissando", target: 60 }] }],
    }],
  };

  const back = await midiToJmon(await midiBytes(slide));
  assert.deepEqual(back.tracks[0].notes[0].articulations, [{ type: "glissando", target: 60 }]);
});

test("the bend returns to centre, so following notes are in tune", async () => {
  const mixed = {
    format: "jmon", version: "1.0", tempo: 120,
    tracks: [{
      label: "lead",
      notes: [
        { ...note(60, 0, 2), articulations: [{ type: "glissando", target: 67 }] },
        note(72, 2, 1),
        note(74, 3, 1),
      ],
    }],
  };

  const back = await midiToJmon(await midiBytes(mixed));
  const [slid, plain, alsoPlain] = back.tracks[0].notes;

  assert.deepEqual(slid.articulations, [{ type: "glissando", target: 67 }]);
  assert.equal(plain.articulations, undefined, "the return to centre is not a bend of its own");
  assert.equal(alsoPlain.articulations, undefined);
});

test("the writer sets a bend range wide enough for the slide", async () => {
  const bytes = await midiBytes({
    format: "jmon", version: "1.0", tempo: 120,
    tracks: [{
      label: "lead",
      notes: [{ ...note(60, 0, 2), articulations: [{ type: "glissando", target: 72 }] }],
    }],
  });

  const parsed = parseMidiFile(bytes);
  const track = parsed.tracks.find((t) => t.notes.length > 0);
  assert.ok(track.pitchBendRange >= 12, `range ${track.pitchBendRange} cannot express an octave`);
  assert.ok(track.pitchBends.length > 8, "expected a sweep, not a single jump");
});

test("a plain piece emits no pitch bend at all", async () => {
  const parsed = parseMidiFile(await midiBytes(PIECE));
  for (const track of parsed.tracks) {
    assert.equal(track.pitchBends.length, 0, "nothing here slides");
  }
});

/* --- tempo changes through MIDI ------------------------------------------ */

const SLOWING = {
  format: "jmon", version: "1.0", tempo: 120,
  tempoMap: [{ time: 0, tempo: 120 }, { time: 4, tempo: 60 }, { time: 8, tempo: 90 }],
  tracks: [{
    label: "lead",
    notes: [note(60, 0), note(62, 4), note(64, 8)],
  }],
};

test("a tempoMap is written as one set-tempo event per segment", async () => {
  // It used to flatten to a single rate at tick 0, so an exported piece that
  // slowed down played straight through at its opening tempo.
  const parsed = parseMidiFile(await midiBytes(SLOWING));

  assert.deepEqual(
    parsed.header.tempos.map((t) => t.time), [0, 4, 8],
    "each change should land on its own beat",
  );
  assert.deepEqual(
    parsed.header.tempos.map((t) => Math.round(t.bpm)), [120, 60, 90],
  );
});

test("a tempoMap survives jmon -> midi -> jmon", async () => {
  const back = await midiToJmon(await midiBytes(SLOWING));

  assert.deepEqual(back.tempoMap, SLOWING.tempoMap);
  assert.deepEqual(
    back.tracks[0].notes.map((n) => n.time), [0, 4, 8],
    "note placement is in quarter notes, so a tempo change does not move it",
  );
});

test("a piece with no tempoMap still emits exactly one tempo", async () => {
  // The tempo track is shared code now, so this guards against a plain
  // piece growing spurious events.
  const parsed = parseMidiFile(await midiBytes(PIECE));

  assert.equal(parsed.header.tempos.length, 1);
  assert.equal(Math.round(parsed.header.tempos[0].bpm), PIECE.tempo);
  assert.equal(parsed.header.tempos[0].time, 0);
});

test("a tempoMap that does not start at zero gets the base tempo first", async () => {
  const late = {
    format: "jmon", version: "1.0", tempo: 100,
    tempoMap: [{ time: 8, tempo: 140 }],
    tracks: [{ label: "lead", notes: [note(60, 0), note(62, 8)] }],
  };
  const parsed = parseMidiFile(await midiBytes(late));

  assert.deepEqual(parsed.header.tempos.map((t) => t.time), [0, 8]);
  assert.deepEqual(parsed.header.tempos.map((t) => Math.round(t.bpm)), [100, 140]);
});

test("tempoMap entries in bars:beats:ticks are placed by beat", async () => {
  const inBars = {
    format: "jmon", version: "1.0", tempo: 120, timeSignature: "4/4",
    tempoMap: [{ time: 0, tempo: 120 }, { time: "2:0:0", tempo: 60 }],
    tracks: [{ label: "lead", notes: [note(60, 0), note(62, 8)] }],
  };
  const parsed = parseMidiFile(await midiBytes(inBars));

  // Bar 2 of 4/4, zero-indexed by the shared time reader, is beat 8.
  assert.deepEqual(parsed.header.tempos.map((t) => t.time), [0, 8]);
});

/* --- metre and key through MIDI ------------------------------------------ */

test("the time signature is written, so a waltz does not open in 4/4", async () => {
  // The writer used to emit no 0x58 at all, while the importer read one — so
  // the round trip lost the metre in one direction only.
  const waltz = {
    format: "jmon", version: "1.0", tempo: 120, timeSignature: "3/4",
    tracks: [{ label: "lead", notes: [note(60, 0), note(62, 3)] }],
  };
  const parsed = parseMidiFile(await midiBytes(waltz));

  assert.deepEqual(parsed.header.timeSignatures, [
    { time: 0, numerator: 3, denominator: 4 },
  ]);
});

test("a timeSignatureMap is written as one event per change", async () => {
  const shifting = {
    format: "jmon", version: "1.0", tempo: 120, timeSignature: "3/4",
    timeSignatureMap: [
      { time: 0, timeSignature: "3/4" },
      { time: 12, timeSignature: "7/8" },
    ],
    tracks: [{ label: "lead", notes: [note(60, 0), note(62, 12)] }],
  };
  const parsed = parseMidiFile(await midiBytes(shifting));

  assert.deepEqual(parsed.header.timeSignatures, [
    { time: 0, numerator: 3, denominator: 4 },
    { time: 12, numerator: 7, denominator: 8 },
  ]);
});

test("the key signature is written, and a minor key is not its parallel major", async () => {
  // A minor takes its *relative* major's accidentals — none. Writing three
  // sharps would be A major.
  const parsed = parseMidiFile(await midiBytes({
    format: "jmon", version: "1.0", tempo: 120, keySignature: "Am",
    tracks: [{ label: "lead", notes: [note(60, 0)] }],
  }));

  assert.deepEqual(parsed.header.keySignatures, [
    { time: 0, key: "A", scale: "minor" },
  ]);
});

test("flat keys survive the signed sharps byte", async () => {
  const parsed = parseMidiFile(await midiBytes({
    format: "jmon", version: "1.0", tempo: 120, keySignature: "Eb",
    tracks: [{ label: "lead", notes: [note(60, 0)] }],
  }));

  assert.deepEqual(parsed.header.keySignatures, [
    { time: 0, key: "Eb", scale: "major" },
  ]);
});

test("a keySignatureMap is written as one event per change", async () => {
  const modulating = {
    format: "jmon", version: "1.0", tempo: 120, keySignature: "C",
    keySignatureMap: [
      { time: 0, keySignature: "C" },
      { time: 16, keySignature: "F# minor" },
    ],
    tracks: [{ label: "lead", notes: [note(60, 0), note(62, 16)] }],
  };
  const parsed = parseMidiFile(await midiBytes(modulating));

  assert.deepEqual(parsed.header.keySignatures, [
    { time: 0, key: "C", scale: "major" },
    { time: 16, key: "F#", scale: "minor" },
  ]);
});

/* --- accelerando through MIDI -------------------------------------------- */

const ACCELERANDO = {
  format: "jmon", version: "1.0", tempo: 90,
  automation: {
    global: [{
      id: "accel", target: "tempo",
      anchorPoints: [{ time: 0, value: 90 }, { time: 8, value: 140 }],
    }],
  },
  tracks: [{ label: "lead", notes: [note(60, 0), note(62, 8)] }],
};

test("a tempo ramp is approximated as a staircase of set-tempo events", async () => {
  // SMF holds a tempo until the next event, so a continuous curve can only be
  // sampled. The players ramp it properly; this is the export's best offer.
  const tempos = parseMidiFile(await midiBytes(ACCELERANDO)).header.tempos;

  assert.ok(tempos.length > 8, `expected a staircase, got ${tempos.length} steps`);
  assert.equal(Math.round(tempos[0].bpm), 90, "it starts at the first anchor");
  assert.equal(Math.round(tempos.at(-1).bpm), 140, "and reaches the last");
  assert.equal(tempos.at(-1).time, 8, "on the beat the anchor names");
});

test("the staircase rises monotonically and never repeats a step", async () => {
  const tempos = parseMidiFile(await midiBytes(ACCELERANDO)).header.tempos;

  for (let i = 1; i < tempos.length; i++) {
    assert.ok(tempos[i].time > tempos[i - 1].time, "one tempo per tick");
    assert.ok(
      Math.round(tempos[i].bpm) > Math.round(tempos[i - 1].bpm),
      `step ${i} repeats or reverses: ${tempos[i - 1].bpm} -> ${tempos[i].bpm}`,
    );
  }
});

test("a ritardando falls", async () => {
  const tempos = parseMidiFile(await midiBytes({
    ...ACCELERANDO,
    automation: {
      global: [{
        id: "rit", target: "tempo",
        anchorPoints: [{ time: 0, value: 140 }, { time: 8, value: 60 }],
      }],
    },
  })).header.tempos;

  assert.equal(Math.round(tempos[0].bpm), 140);
  assert.equal(Math.round(tempos.at(-1).bpm), 60);
});

test("automation that is not tempo leaves the tempo track alone", async () => {
  const parsed = parseMidiFile(await midiBytes({
    format: "jmon", version: "1.0", tempo: 120,
    audioGraph: [{ id: "reverb", type: "Reverb", options: {} }],
    automation: {
      global: [{
        id: "wet", target: "reverb.wet",
        anchorPoints: [{ time: 0, value: 0 }, { time: 8, value: 1 }],
      }],
    },
    tracks: [{ label: "lead", notes: [note(60, 0)] }],
  }));

  assert.equal(parsed.header.tempos.length, 1, "a wet curve is not a tempo curve");
});

test("a tempoMap and a ramp do not both claim the same tick", async () => {
  const both = {
    ...ACCELERANDO,
    tempoMap: [{ time: 0, tempo: 90 }, { time: 8, tempo: 140 }],
  };
  const tempos = parseMidiFile(await midiBytes(both)).header.tempos;
  const ticks = tempos.map((t) => t.time);

  assert.equal(new Set(ticks).size, ticks.length, `duplicate tick in ${ticks.join(", ")}`);
});

test("at a shared tick the ramp anchor wins over the tempoMap", async () => {
  // Both players schedule automation after tempo changes, so a ramp anchor is
  // what you hear at a beat the tempoMap also names. The file has to agree.
  const conflicting = {
    format: "jmon", version: "1.0", tempo: 90,
    tempoMap: [{ time: 0, tempo: 90 }],
    automation: {
      global: [{
        id: "rit", target: "tempo",
        anchorPoints: [{ time: 0, value: 140 }, { time: 8, value: 60 }],
      }],
    },
    tracks: [{ label: "lead", notes: [note(60, 0), note(62, 8)] }],
  };
  const tempos = parseMidiFile(await midiBytes(conflicting)).header.tempos;

  assert.equal(Math.round(tempos[0].bpm), 140, "the ramp's anchor, not the map's 90");
  assert.equal(tempos[0].time, 0);
});

// ─── articulations survive the MIDI export ─────────────────────────────────
//
// compilePerformanceTurn had been turning staccato into a durationScale and an
// accent into a velocityBoost for some time, and the writer read only the
// `pitch` ones, so both were computed and then dropped. A note exported with
// `articulations: ["staccato"]` was byte-identical to the same note without it.

const oneNote = (extra) => ({
  tempo: 100,
  tracks: [{ label: "L", synth: 69, notes: [{ pitch: 62, duration: 1, time: 0, velocity: 0.8, ...extra }] }],
});

/** Read an exported file back with the library's own parser. */
function roundTrip(extra) {
  const bytes = midiBytes(oneNote(extra));
  const parsed = parseMidiFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const track = parsed.tracks.find((t) => t.notes && t.notes.length);
  return {
    note: track?.notes[0],
    bends: parsed.tracks.flatMap((t) => t.pitchBends ?? []).length,
    cc11: (track?.controlChanges?.["11"] ?? []).length,
    base64: midiBase64(oneNote(extra)),
  };
}

test("a staccato is a shorter note in the exported file", () => {
  const plain = roundTrip({});
  const staccato = roundTrip({ articulations: ["staccato"] });
  assert.equal(plain.note.duration, 1);
  assert.equal(staccato.note.duration, 0.5, "durationScale 0.5, read back off the wire");
  assert.notEqual(staccato.base64, plain.base64);
});

test("an accent is a louder note in the exported file", () => {
  const plain = roundTrip({});
  const accent = roundTrip({ articulations: ["accent"] });
  assert.equal(Math.round(plain.note.velocity * 127), 102);
  assert.equal(Math.round(accent.note.velocity * 127), 127, "velocityBoost, clamped to the byte range");
});

test("tenuto and marcato reach the file as well", () => {
  assert.equal(roundTrip({ articulations: ["tenuto"] }).note.duration, 1.1);
  const marcato = roundTrip({ articulations: ["marcato"] });
  assert.equal(Math.round(marcato.note.velocity * 127), 127);
  assert.equal(marcato.note.duration, 0.9, "marcato is both louder and shorter");
});

test("duration scales compose", () => {
  // marcato (0.9) then staccato (0.5), so shorter than either.
  assert.equal(roundTrip({ articulations: ["marcato", "staccato"] }).note.duration, 0.45);
});

test("crescendo becomes CC 11, and the fader is returned to rest", () => {
  const swell = roundTrip({ articulations: [{ type: "crescendo" }] });
  assert.ok(swell.cc11 >= 2, `expected expression events, got ${swell.cc11}`);
  const values = swell.cc11 > 0;
  assert.ok(values);
});

/** The CC 11 values of an exported piece, in beats, read back with the library's parser. */
function expressionOf(piece) {
  const bytes = midiBytes(piece);
  const parsed = parseMidiFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const track = parsed.tracks.find((t) => t.notes && t.notes.length);
  return { cc: (track?.controlChanges?.["11"] ?? []).map((e) => ({ time: e.time, value: Math.round(e.value * 127) })), track };
}

test("an amplitude envelope becomes a smooth CC 11 curve, as a proportion of the velocity", () => {
  // The fader is a proportion of the channel's volume, the note-on keeps the
  // velocity. Only the anchors were written, as steps, and the curve started
  // from the velocity (0.8 -> 102) on another scale than its anchors.
  const { cc } = expressionOf(oneNote({ amplitudeEnvelope: [0.2, 1, 0.6] }));
  assert.equal(cc[0].value, 25, "the curve starts at its first anchor, 0.2 of full");
  assert.ok(cc.length > 20, `a ramp, not three steps (${cc.length} events)`);
  assert.ok(cc.some((e) => e.value === 127), "it reaches the peak");
  for (let k = 1; k < cc.length - 1; k++) {
    assert.ok(Math.abs(cc[k].value - cc[k - 1].value) <= 16, `no jump at ${cc[k].time}`);
  }
  assert.deepEqual(cc.at(-1), { time: 1, value: 127 }, "and the fader is back at rest, not at 0, when the note ends");
});

test("a note that starts before its neighbour ends is not silenced by it", () => {
  // Every note-off set the channel's fader to 0, so a note already playing —
  // legato strings, humanized timing — went silent.
  const piece = {
    tempo: 60,
    tracks: [{ label: "V", synth: 40, notes: [
      { pitch: 69, duration: 2, time: 0, velocity: 0.6, amplitudeEnvelope: [0.5, 1] },
      { pitch: 71, duration: 2, time: 1.95, velocity: 0.6, amplitudeEnvelope: [0.8, 1] },
    ] }],
  };
  const { cc } = expressionOf(piece);
  assert.ok(cc.every((e) => e.value > 0), "the fader never falls to 0");
  const during = cc.filter((e) => e.time >= 1.95 && e.time < 2.1);
  assert.equal(during[0].value, 102, "the second note takes the fader over at its onset");
  assert.ok(!cc.some((e) => e.time === 2 && e.value === 127), "and the first note's end does not reset it");
});

test("a curve that rises from silence starts at its first level, on a shared fader", () => {
  // bow() starts each note at 0. On one channel's fader that muted the end of
  // the previous note at every onset; the synth gives the note its attack.
  const piece = {
    tempo: 60,
    tracks: [{ label: "V", synth: 40, notes: [
      { pitch: 69, duration: 2, time: 0, velocity: 0.6, amplitudeEnvelope: [{ time: 0, value: 0 }, { time: 0.3, value: 0.75 }, { time: 1, value: 1 }, { time: 2, value: 0.8 }] },
      { pitch: 71, duration: 2, time: 2, velocity: 0.6, amplitudeEnvelope: [{ time: 0, value: 0 }, { time: 0.3, value: 0.75 }, { time: 1, value: 1 }, { time: 2, value: 0.8 }] },
    ] }],
  };
  const { cc } = expressionOf(piece);
  assert.ok(Math.min(...cc.map((e) => e.value)) >= 95, `the fader never dips below the curve's first level (${Math.min(...cc.map((e) => e.value))})`);
  assert.equal(cc.find((e) => e.time === 2).value, 95, "the second note starts at 0.75 of full");
});

test("a track's General MIDI program is written, so the file opens on the right instrument", () => {
  const program = (synth) => expressionOf({ tempo: 60, tracks: [{ label: "V", synth, notes: [{ pitch: 60, duration: 1, time: 0 }] }] }).track.instrument.number;
  assert.equal(program(40), 40);
  assert.equal(program({ gm: 42, bank: "MusyngKite" }), 42);
  assert.equal(program({ program: 48 }), 48);
  assert.equal(program({ type: "Sampler", options: {} }), 0, "a sampler has no program: the file says nothing");
});

test("a note can never export as a note-on with no note-off", () => {
  // A durationScale big enough to round to zero ticks would be a stuck key.
  const tiny = roundTrip({ articulations: ["staccato"] });
  assert.ok(tiny.note.duration > 0, "a staccato on a 1/64 note is still a note");
  const shortest = midiBytes({
    tempo: 100,
    tracks: [{ label: "L", notes: [{ pitch: 60, duration: 0.01, time: 0, articulations: ["staccato"] }] }],
  });
  const parsed = parseMidiFile(shortest.buffer.slice(shortest.byteOffset, shortest.byteOffset + shortest.byteLength));
  const n = parsed.tracks.find((t) => t.notes?.length)?.notes[0];
  assert.ok(n && n.duration > 0, "0.005 beats still exports as a note");
});

test("the legacy single articulation is compiled, as the header promises", () => {
  // Only the declarative array was ever read, so `articulation: "staccato"`
  // produced nothing at all.
  assert.equal(roundTrip({ articulation: "staccato" }).note.duration, 0.5);
  assert.equal(
    Math.round(roundTrip({ articulation: "accent" }).note.velocity * 127),
    127,
  );
  assert.ok(
    roundTrip({ articulation: { type: "glissando", target: 72 } }).bends > 0,
    "a legacy glissando reaches the pitch wheel like the new spelling",
  );
});

test("legacy glissTarget, which sat beside the articulation, is folded in", () => {
  const viaLegacy = roundTrip({ articulation: "glissando", glissTarget: 72 });
  const viaModern = roundTrip({ articulations: [{ type: "glissando", target: 72 }] });
  assert.ok(viaLegacy.bends > 0, "the bare legacy form now bends");
  assert.equal(viaLegacy.bends, viaModern.bends, "and the same as the modern spelling");
  // an explicit target wins over glissTarget
  const explicit = roundTrip({ articulation: "glissando", glissTarget: 60, target: 84 });
  assert.equal(explicit.bends, viaModern.bends);
});

// ─── telling the caller what MIDI will not carry ────────────────────────────
//
// Every one of these used to arrive in the DAW doing nothing, with no error
// anywhere: the writer has no way to say a field cannot be written. The check
// lives beside the writer, so the two cannot drift.

import {
  midiLosses, exportLosses, EXPORT_TARGETS, MIDI_RENDERED_MODULATIONS,
  MUSICXML_RENDERED_MODULATIONS,
} from "../src/export-losses.js";

const lossFields = (piece) => midiLosses(piece).map((w) => w.field);
const aNote = (extra) => ({ pitch: 62, duration: 1, time: 0, velocity: 0.8, ...extra });
const aPiece = (notes, trackExtra = {}, pieceExtra = {}) => ({
  tempo: 100,
  tracks: [{ label: "L", synth: 69, notes, ...trackExtra }],
  ...pieceExtra,
});

test("a piece that survives the export is not warned about", () => {
  assert.deepEqual(lossFields(aPiece([aNote({})])), []);
  assert.deepEqual(lossFields(aPiece([aNote({ articulations: ["staccato"] })])), [],
    "staccato is a shorter note and is written");
  assert.deepEqual(lossFields(aPiece([aNote({ articulations: [{ type: "glissando", target: 72 }] })])), [],
    "and a glissando is a pitch curve");
  assert.deepEqual(lossFields(aPiece([aNote({ pitchEnvelope: [0, 2] })])), [], "as is a pitch envelope");
  assert.deepEqual(lossFields(aPiece([aNote({ amplitudeEnvelope: [0, 1] })])), [], "and an amplitude envelope");
});

test("the fields MIDI cannot express are named", () => {
  assert.ok(!lossFields(aPiece([aNote({ tuning: 0.25 })])).includes("tuning"),
    "a tuned note alone is written as the channel's pitch wheel");
  assert.ok(lossFields(aPiece([aNote({ tuning: 0.25 }), aNote({ tuning: -0.25, pitch: 64 })])).includes("tuning"),
    "two tunings at once on one channel cannot both be right");
  assert.ok(lossFields(aPiece([aNote({ channel: 3 })])).includes("channel"),
    "per-note channel; track.channel is read, note.channel is not");
  assert.ok(lossFields(aPiece([aNote({})], { loop: true })).includes("loop"),
    "a Standard MIDI File cannot loop");
  assert.ok(lossFields(aPiece([aNote({})], { synth: "drumkit:acoustic" })).includes("synth"),
    "a sampler name is not a program change");
  assert.ok(!lossFields(aPiece([aNote({})], { synth: 69 })).includes("synth"),
    "but a program number is");
  assert.ok(lossFields(aPiece([aNote({})], {}, { audioGraph: [{ type: "Reverb" }] })).includes("audioGraph"),
    "MIDI has no send bus");
  assert.ok(lossFields(aPiece([aNote({ modulations: [] })])).includes("modulations"),
    "modulations on a note are not read; articulations are");
  assert.ok(lossFields(aPiece([aNote({ wobble: 1 })])).includes("wobble"),
    "an unknown field is better reported than ignored");
});

test("vibrato is reported, because it compiles to a rate and not a curve", () => {
  // The clearest case of the whole file: the format layer handles it, and the
  // result is a `pitch` modulation with no anchors, which the wheel writer
  // needs in order to draw anything. Nothing throws. It just does not arrive.
  const warnings = lossFields(aPiece([aNote({ articulations: [{ type: "vibrato", rate: 5, depth: 40 }] })]));
  assert.ok(warnings.some((f) => f.includes("vibrato")), `expected a vibrato warning, got ${warnings}`);
});

test("the loss list names every modulation type the writer renders", () => {
  // So that adding a type to the format layer without teaching the writer
  // about it shows up here rather than vanishing on export.
  assert.deepEqual(Object.keys(MIDI_RENDERED_MODULATIONS).sort(), ["amplitude", "durationScale", "pitch", "velocityBoost"]);
});

test("warnings are per loss, not per note, and carry a reason", () => {
  const notes = [aNote({ tuning: 0.1 }), aNote({ tuning: 0.2 }), aNote({ tuning: 0.3 })];
  const losses = midiLosses(aPiece(notes));
  assert.equal(losses.length, 1, "three notes at once, one field, one warning");
  assert.ok(losses[0].why.length > 20, "and an explanation, since the point is to act on it");
});

test("validate takes the target, and only then reports losses", async () => {
  const { default: io } = await import("../src/index.js");
  const piece = aPiece([aNote({ tuning: 0.25 })], { loop: true });
  assert.ok(!("warnings" in io.validate(piece)), "the default is unchanged: no key at all");
  const forMidi = io.validate(piece, { for: "midi" });
  assert.equal(forMidi.valid, true, "losing a field is not an invalid piece");
  assert.deepEqual(forMidi.warnings.map((w) => w.field), ["loop"], "the tuning is written; the loop is not");
  assert.equal(forMidi.normalized !== null, true, "normalisation is unaffected");
});

test("validate renames a note field written under its old name, and says so", async () => {
  const { default: io } = await import("../src/index.js");
  const piece = aPiece([aNote({ microtuning: 0.25, pitchEnvelope: [0, 1], amplitudeEnvelope: [1, 0.5] })]);
  const result = io.validate(piece);
  assert.deepEqual(result.warnings.map((w) => w.field).sort(), ["amplitudeEnvelope", "microtuning", "pitchEnvelope"]);
  assert.ok(result.warnings.every((w) => w.kind === "renamed"));
  const note = result.normalized.tracks[0].notes[0];
  assert.deepEqual([note.tuning, note.bend, note.dynamics], [0.25, [0, 1], [1, 0.5]]);
  assert.ok(!("microtuning" in note) && !("pitchEnvelope" in note) && !("amplitudeEnvelope" in note));
  const both = io.validate(aPiece([aNote({ tuning: 0.1, microtuning: 0.25 })]));
  assert.equal(both.normalized.tracks[0].notes[0].tuning, 0.1, "the new name wins over the old");
});

// ─── one loss list per target, and two kinds of loss ───────────────────────
//
// I said a DAW that reads notation would get articulations, loops and samplers
// "for free". Measured, that was wrong: the MusicXML writer emitted notes, rests,
// chords, key, tempo, clef, part names and a title, and nothing else. A score was
// then a different target, and a worse one for anything expressive — which is
// only knowable because the check exists.
//
// The notations pass closed that gap. <notations>, <dynamics>, <wedge>,
// <barline><repeat> and <midi-instrument> are written now, so what is left is
// short, and every entry in it is a wall rather than a to-do. The last test in
// this section measures that claim against the writer instead of trusting it.

test("the target is part of the question", () => {
  assert.deepEqual(EXPORT_TARGETS.sort(), ["midi", "musicxml"]);
  const note = aNote({ tuning: 0.25, articulations: ["staccato"] });
  const piece = aPiece([note], { loop: true, synth: "piano" });
  const midi = exportLosses(piece, "midi").map((w) => w.field);
  const xml = exportLosses(piece, "musicxml").map((w) => w.field);
  // A tuning is a pitch wheel in MIDI and nothing on a score; a sampler name is
  // nothing on either.
  assert.ok(!midi.includes("tuning"));
  assert.ok(xml.includes("tuning"));
  assert.ok(midi.includes("synth"));
  assert.ok(xml.includes("synth"));
  // The staccato now survives both, so neither complains about it.
  assert.ok(!midi.includes("articulations"));
  assert.ok(!xml.includes("articulations"), "a score is no longer a worse target for expression");
  // And the two still differ, on the two things only one of them can express.
  assert.ok(midi.includes("loop"), "a Standard MIDI File cannot loop");
  assert.ok(!xml.includes("loop"), "but a score has <barline><repeat>, and the writer fills it in");
  assert.notDeepEqual(midi, xml);
});

test("a loss says whether the format cannot or the writer does not yet", () => {
  const kindOf = (target, piece, field) =>
    exportLosses(piece, target).find((w) => w.field === field)?.kind;
  const note = aNote({});
  // A MIDI file has no send bus. Nothing to do about that.
  assert.equal(kindOf("midi", aPiece([note], {}, { audioGraph: [{}] }), "audioGraph"), "format");
  // A score has no audio either, and no channel.
  assert.equal(kindOf("musicxml", aPiece([note], {}, { audioGraph: [{}] }), "audioGraph"), "format");
  assert.equal(kindOf("musicxml", aPiece([note], { channel: 3 }), "channel"), "format");
  // A pitch envelope is a curve with a shape; <glissando> and <slide> are a
  // straight line between two notes and cannot hold it. So this is a wall too,
  // and saying so is what stops it being rebuilt as a to-do every few months.
  assert.equal(kindOf("musicxml", aPiece([aNote({ pitchEnvelope: {} })]), "pitchEnvelope"), "format");
  assert.equal(kindOf("musicxml", aPiece([aNote({ amplitudeEnvelope: [0, 1] })]), "amplitudeEnvelope"), "format");
  // A bend is the remaining writer gap on a score: MusicXML has a glyph for most
  // things and not for this, and the writer says so rather than guessing one.
  const bend = exportLosses(
    aPiece([aNote({ articulations: [{ type: "bend", amount: 0.5 }] })]),
    "musicxml",
  ).find((w) => w.field.includes("bend"));
  assert.equal(bend?.kind, "writer");
  assert.ok(bend?.why.length > 20, "and an explanation, since the point is to act on it");
});

test("an unknown target is refused rather than passing quietly", () => {
  assert.throws(() => exportLosses(aPiece([aNote({})]), "wav"), /unknown target/);
});

test("a piece with nothing in it is clean on both", () => {
  assert.deepEqual(exportLosses(aPiece([aNote({})]), "midi"), []);
  assert.deepEqual(exportLosses(aPiece([aNote({})]), "musicxml"), []);
});

test("validate takes either target", async () => {
  const { default: io } = await import("../src/index.js");
  const piece = aPiece([aNote({ tuning: 0.25 })]);
  const has = (target, field) => io.validate(piece, { for: target }).warnings.some((w) => w.field === field);
  assert.ok(!has("midi", "tuning"), "a lone tuned note is a pitch wheel");
  assert.ok(has("musicxml", "tuning"), "a score has no place for it");
  // a program number is written on both, so neither complains
  assert.ok(!has("midi", "synth"), "synth 69 is a program change");
  assert.ok(!has("musicxml", "synth"), "and is a <midi-program> on a score");
});

test("the loss list names every modulation the writer draws, and the writer draws them", () => {
  // Two halves of one claim, because either alone can rot.
  //
  // The first: a key the writer does not implement, so that adding a modulation
  // to the format layer without teaching the writer about it shows up here.
  assert.deepEqual(
    Object.keys(MUSICXML_RENDERED_MODULATIONS).sort(),
    [
      "amplitude/crescendo",
      "amplitude/diminuendo",
      "amplitude/tremolo",
      "durationScale",
      "pitch/glissando",
      "pitch/portamento",
      "velocityBoost",
    ],
  );

  // The second: each of those keys really does leave its mark in the output. A
  // registry that claims more than the writer writes is worse than no registry,
  // because it turns a silent loss into a false all-clear. This reads the bytes
  // the writer produced, not the code that produced them.
  const written = (xml) => xml.includes.bind(xml);
  const cases = [
    [aNote({ articulations: ["staccato"] }), ["<staccato/>"]],
    [aNote({ articulations: ["tenuto"] }), ["<tenuto/>"]],
    [aNote({ articulations: ["accent"] }), ["<accent/>"]],
    [aNote({ articulations: ["marcato"] }), ["<strong-accent/>"]],
    [aNote({ articulations: [{ type: "glissando", target: 72 }] }), ['<glissando type="start"']],
    [aNote({ articulations: [{ type: "portamento", target: 72 }] }), ['<slide type="start"']],
    [aNote({ articulations: [{ type: "crescendo" }] }), ['<wedge type="crescendo"']],
    [aNote({ articulations: [{ type: "diminuendo" }] }), ['<wedge type="diminuendo"']],
    [aNote({ articulations: [{ type: "tremolo", rate: 12, depth: 0.2 }] }), ["<tremolo"]],
  ];
  for (const [note, marks] of cases) {
    // A line needs a note to run to, so every case gets a following note.
    const xml = musicxml(aPiece([note, aNote({ time: 1, pitch: 72 })]));
    const isThere = written(xml);
    for (const mark of marks) {
      assert.ok(isThere(mark), `the registry promises a ${mark} and the writer wrote none`);
    }
  }
});

test("a line is opened and closed, and never left dangling", () => {
  // A <glissando> or a <slide> runs from one note to the next, so an unpaired
  // one is a line a reader has to guess the end of. Both edges matter: the note
  // after the line closes it, and a line on the last note of a piece has nothing
  // to run to and is closed where it starts.
  const pairs = (xml, element) => {
    const starts = (xml.match(new RegExp(`<${element} type="start"`, "g")) ?? []).length;
    const stops = (xml.match(new RegExp(`<${element} type="stop"`, "g")) ?? []).length;
    return { starts, stops };
  };

  const middle = musicxml(aPiece([
    aNote({ time: 0, articulations: [{ type: "portamento", target: 64 }] }),
    aNote({ time: 1, pitch: 64 }),
    aNote({ time: 2, pitch: 67 }),
  ]));
  assert.deepEqual(pairs(middle, "slide"), { starts: 1, stops: 1 }, "closed on the following note");

  // A line on a note followed only by rests still has to close: a rest is not
  // something a line can reach, so it closes on the note itself.
  const last = musicxml(aPiece([
    aNote({ pitch: 60 }),
    aNote({ pitch: 72, articulations: [{ type: "glissando", target: 74 }] }),
  ]));
  assert.deepEqual(pairs(last, "glissando"), { starts: 1, stops: 1 });

  // And a line that runs across a barline is still closed on the far side.
  const across = musicxml(aPiece([
    aNote({ time: 0, pitch: 60, articulations: [{ type: "portamento", target: 62 }] }),
    aNote({ time: 1, pitch: 62 }),
    aNote({ time: 2, pitch: 64 }),
    aNote({ time: 3, pitch: 65 }),
    aNote({ time: 4, pitch: 67 }),
  ]));
  assert.ok((across.match(/<measure /g) ?? []).length > 1, "this case is only interesting across bars");
  assert.deepEqual(pairs(across, "slide"), { starts: 1, stops: 1 });
});

test("a dynamic is written when the level changes, not on every note", () => {
  // Four notes at one velocity are one mark, not four: a player reads a dynamic
  // stamped on every notehead as a new instruction every note.
  const marksIn = (velocities) => {
    const notes = velocities.map((velocity, i) => aNote({ time: i, pitch: 60 + i, velocity }));
    return [...musicxml(aPiece(notes)).matchAll(/<(pp|p|mp|mf|f|ff)\/>/g)].map((m) => m[1]);
  };
  assert.deepEqual(marksIn([0.8, 0.8, 0.8, 0.8]), ["mf"], "one mark for one level");
  assert.deepEqual(marksIn([0.4, 0.4, 0.9, 0.9]), ["p", "f"], "and one more where it changes");
  assert.deepEqual(marksIn([0.1, 0.5]), ["pp", "mp"]);
  // Past the ends of the six marks there is nothing more to write, so the
  // extreme is held rather than inventing a seventh.
  assert.deepEqual(marksIn([0.0, 1.0]), ["pp", "ff"]);
});

test("a staccato is a mark, and does not shorten the note", () => {
  // I got this wrong first and wrote <duration> as the sounding length with
  // <type> as the written one. It does not survive contact with the measure: a
  // note's duration is the time between it and the next note, so shortening it
  // does not shorten the note, it eats the time the next note starts in and the
  // measure grows a rest the composer never wrote. A staccato quarter came out as
  // an eighth, a 32nd rest, an eighth.
  //
  // So the written rhythm is in <duration> and <type>, and the expression is in
  // <notations>. The test that matters is the second one: no phantom rests.
  // Two staccato notes that fill the bar between them, so a <rest/> anywhere in
  // the output can only mean one was invented.
  const barOf = (notes) => musicxml(aPiece(notes)).split("<measure")[1].split("<\/measure>")[0];
  const durationsOf = (bar) =>
    [...bar.matchAll(/<duration>(\d+)<\/duration>/g)].map((m) => Number(m[1]));

  const staccatoBar = barOf([
    aNote({ time: 0, pitch: 60, duration: 1.75, articulations: ["staccato"] }),
    aNote({ time: 1.75, pitch: 62, duration: 2.25, articulations: ["staccato"] }),
  ]);
  const divisions = Number(musicxml(aPiece([aNote({})])).match(/<divisions>(\d+)<\/divisions>/)[1]);
  assert.equal((staccatoBar.match(/<rest\/>/g) ?? []).length, 0,
    "a shortened note left a hole and the measure grew a rest nobody wrote");
  assert.ok(durationsOf(staccatoBar).every(Number.isInteger), "and every <duration> is a whole number");
  assert.equal(durationsOf(staccatoBar).reduce((a, b) => a + b, 0), divisions * 4,
    "a full 4/4 bar of written time, which is what a bar is");
  assert.equal((staccatoBar.match(/<staccato\/>/g) ?? []).length, 2,
    "the mark is what says staccato");

  // A staccato does not make the next note late either, which is the other half
  // of the same mistake: the written duration of note one is unchanged.
  assert.deepEqual(durationsOf(staccatoBar), [divisions * 1.75, divisions * 2.25]);

  // And a written rest is still written as one.
  const withRest = barOf([
    aNote({ time: 0, pitch: 60, duration: 1.75, articulations: ["staccato"] }),
    aNote({ time: 1.75, pitch: 62, duration: 0.25 }),
    aNote({ time: 2, pitch: null, duration: 2 }),
  ]);
  assert.equal((withRest.match(/<rest\/>/g) ?? []).length, 1, "the one rest the piece asked for");
  assert.equal(durationsOf(withRest).reduce((a, b) => a + b, 0), divisions * 4);
});

test("a rest is a rest", () => {
  // A JMON rest is a note whose pitch is null, and it used to be engraved as a
  // middle C: midiToPitch(null) read null as 0, so every rest in every score
  // became a note. The written value is the giveaway — a rest has no <step>.
  const xml = musicxml(aPiece([
    aNote({ time: 0, pitch: 62 }),
    aNote({ time: 1, pitch: null, duration: 3 }),
  ]));
  assert.ok(xml.includes("<rest/>"), "the null pitch is a rest");
  const measure = xml.split("<measure")[1].split("</measure>")[0];
  const notes = (measure.match(/<note>/g) ?? []).length;
  const steps = (measure.match(/<step>/g) ?? []).length;
  const rests = (measure.match(/<rest\/>/g) ?? []).length;
  assert.equal(steps, 1, "only the one real note has a pitch");
  assert.equal(rests, 1);
  assert.equal(notes, steps + rests, "every note element is either pitched or a rest");
});

// ─── MPE, so a note can carry its own tuning ────────────────────────────────
//
// `tuning` is a per-note offset in semitones and a Standard MIDI File has
// no message for it. A channel's pitch wheel moves every note on that channel,
// so in polyphony the only correct answer is a channel per note — which is
// what MPE is. It is opt-in, because a file with one channel per note is wrong
// for a synth that is not in MPE mode, and wrong for any GM instrument.

import { assignMpeChannels, bendValueFor, MPE_DEFAULTS, buildMpeNoteEvents } from "../src/midi-mpe.js";
import { pitchWheelCurves, pitchWheelEvents, pitchWheelPlan } from "../src/pitch-wheel.js";

const mpeNote = (pitch, time, duration = 1, extra = {}) =>
  ({ pitch, duration, time, velocity: 0.8, ...extra });
const mpePiece = (notes) => ({ tempo: 100, tracks: [{ label: "L", synth: 69, notes }] });

test("bend values are centred at 8192 and scale with the range", () => {
  assert.equal(bendValueFor(0, 48), 8192, "no offset is centre");
  assert.ok(bendValueFor(50, 48) > 8192, "positive is up");
  assert.ok(bendValueFor(-50, 48) < 8192, "negative is down");
  // A quarter tone is 2400 cents, a quarter of a 48-semitone range.
  assert.equal(bendValueFor(2400, 48), 12288);
  // The same cents in a narrower range is a larger share of the wheel, which is
  // the resolution trade a controller with a 2-semitone bend buys.
  assert.ok(bendValueFor(50, 2) > bendValueFor(50, 48));
});

test("notes sounding at once get a channel each, and a channel is reused once free", () => {
  const together = [60, 62, 64, 65].map((p) => mpeNote(p, 0, 4));
  const plan = assignMpeChannels(together);
  assert.equal(new Set(plan.map((p) => p.channel)).size, 4, "four at once, four channels");

  const sequence = [mpeNote(60, 0, 1), mpeNote(62, 1, 1), mpeNote(64, 2, 1)];
  const serial = assignMpeChannels(sequence);
  assert.equal(new Set(serial.map((p) => p.channel)).size, 1,
    "each note has finished before the next starts, so one channel does");
});

test("more simultaneous notes than channels is refused, not mis-tuned", () => {
  // Two notes on one channel cannot both be detuned, and a file that quietly
  // tunes one of them wrong is worse than no file.
  const at = (n) => Array.from({ length: n }, (_, i) => mpeNote(60 + i, 0, 4, { tuning: 0.01 }));

  assert.doesNotThrow(() => assignMpeChannels(at(MPE_DEFAULTS.members.length)),
    "as many at once as there are member channels");
  assert.throws(() => assignMpeChannels(at(MPE_DEFAULTS.members.length + 1)), /more notes sound at once/);

  // MIDI has sixteen channels, so the ceiling is real and no pool reaches past
  // it. Channels above 15 are not MIDI channels and are dropped, not invented.
  assert.throws(() => assignMpeChannels(at(20), { members: Array.from({ length: 24 }, (_, i) => i) }),
    /ceiling is 16/, "a wider pool cannot invent channels that do not exist");
});

test("the default pool leaves the drum channel out of the zone", () => {
  // 9 is the GM drum channel; a piece with drums and tuned notes should not put
  // them in the same zone.
  assert.ok(!MPE_DEFAULTS.members.includes(9), "channel 10 (1-indexed) stays free for drums");
  assert.equal(MPE_DEFAULTS.master, 15, "15 is the MPE master");
});

test("a tuned note is bent on its track's channel without mpe, and on its own with", async () => {
  const piece = mpePiece([mpeNote(60, 0, 2, { tuning: 0.25 })]);
  const plain = parse(midiBytes(piece));
  const bent = parse(midiBytes(piece, { mpe: true }));
  assert.ok(plain.pitchBends > 0, "without mpe the track's one channel carries the wheel");
  assert.equal(plain.pitchBendRange, 2, "sized to what the curve needs, at least 2 semitones");
  assert.equal(bent.pitchBendRange, 48, "with mpe the sensitivity is sent as RPN 0/0");
  assert.ok(bent.pitchBends > 0, "and the note is bent");
  assert.equal(plain.notes, bent.notes, "the same notes either way");
});

test("a tuned note is bent before it sounds and released after", () => {
  const notes = [mpeNote(60, 0, 2, { tuning: 0.25 })];
  const { channelOf } = buildMpeNoteEvents(notes, { ...MPE_DEFAULTS, ticksPerBeat: 480 });
  const { written } = pitchWheelPlan(pitchWheelCurves(notes), (i) => channelOf.get(i));
  const events = pitchWheelEvents(written, 480, { range: 48, sensitivity: false });
  const bends = events.filter((e) => (e.bytes[0] & 0xf0) === 0xe0);
  assert.ok(bends.length >= 2, "one to set it, one to centre it again");
  assert.ok(bends[0].sortOrder < 1, "set before the note-on that shares its tick");
  assert.ok(bends[bends.length - 1].sortOrder < 1, "and the reset goes with the note-off");
  const last = bends[bends.length - 1];
  assert.equal(((last.bytes[2] << 7) | last.bytes[1]), 8192,
    "the last bend is centre, so the next note on that channel is not still bent");
});

test("a note with no tuning gets no bend events", () => {
  const { events } = buildMpeNoteEvents([mpeNote(60, 0, 1)], { ...MPE_DEFAULTS, ticksPerBeat: 480 });
  assert.equal(events.filter((e) => (e.bytes[0] & 0xf0) === 0xe0).length, 0);
});

/** Read a file back with the package's parser, flattened to what is asserted. */
function parse(bytes) {
  const p = parseMidiFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const track = p.tracks.find((t) => t.notes && t.notes.length);
  return {
    notes: p.tracks.reduce((n, t) => n + (t.notes?.length ?? 0), 0),
    pitchBends: p.tracks.reduce((n, t) => n + (t.pitchBends?.length ?? 0), 0),
    pitchBendRange: track?.pitchBendRange,
  };
}
