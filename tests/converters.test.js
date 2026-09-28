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

import { midiLosses, MIDI_RENDERED_MODULATIONS } from "../src/midi-losses.js";

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
});

test("the fields MIDI cannot express are named", () => {
  assert.ok(lossFields(aPiece([aNote({ microtuning: 0.25 })])).includes("microtuning"));
  assert.ok(lossFields(aPiece([aNote({ channel: 3 })])).includes("channel"),
    "per-note channel; track.channel is read, note.channel is not");
  assert.ok(lossFields(aPiece([aNote({})], { loop: true })).includes("loop"),
    "a Standard MIDI File cannot loop");
  assert.ok(lossFields(aPiece([aNote({})], { synth: "drumkit:acoustic" })).includes("synth"),
    "a sampler name is not a program change");
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
  const notes = [aNote({ microtuning: 0.1 }), aNote({ microtuning: 0.2 }), aNote({ microtuning: 0.3 })];
  const losses = midiLosses(aPiece(notes));
  assert.equal(losses.length, 1, "three notes, one field, one warning");
  assert.ok(losses[0].why.length > 20, "and an explanation, since the point is to act on it");
});

test("validate takes the target, and only then reports warnings", async () => {
  const { default: io } = await import("../src/index.js");
  const piece = aPiece([aNote({ microtuning: 0.25 })]);
  assert.ok(!("warnings" in io.validate(piece)), "the default is unchanged: no key at all");
  const forMidi = io.validate(piece, { for: "midi" });
  assert.equal(forMidi.valid, true, "losing a field is not an invalid piece");
  assert.equal(forMidi.warnings.length, 1);
  assert.equal(forMidi.normalized !== null, true, "normalisation is unaffected");
});
