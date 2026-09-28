import test from "node:test";
import assert from "node:assert/strict";

// Control changes: the one MIDI message every VST listens for.
//
// JMON could not say "set controller 74 to 0.4" at all. CC 11 appeared only as a
// by-product of an `amplitude` modulation, so a piece had no way to carry a filter
// sweep, a mod wheel, or anything else a plugin maps — which made MIDI CC, the
// universal plugin-control protocol, unreachable from the format. With no way to
// write a controller change, controlling a VST from a notebook meant bypassing
// JMON entirely.
//
// The shape is a list of steps on the track, because a controller is told a value
// and holds it: there is no duration to write and nothing to release.
import { midiBytes } from "../src/midi.js";
import { midiToJmon } from "../src/midi-to-jmon.js";
import { parseMidiFile } from "../src/midi-parser.js";
import { exportLosses } from "../src/export-losses.js";

const note = (extra = {}) => ({ pitch: 60, time: 0, duration: 1, velocity: 0.8, ...extra });
const pieceWith = (track, extra = {}) => ({
  format: "jmon", version: "1.0", tempo: 120,
  tracks: [{ label: "lead", midiChannel: 0, notes: [note()], ...track }],
  ...extra,
});

// parseMidiFile puts the conductor track first and the note tracks after it, so
// the track named "lead" is not tracks[0]. That is a trap worth naming.
const lead = (parsed) =>
  parsed.tracks.find((t) => t.name === "lead") ?? parsed.tracks.at(-1);

const controllersOf = (parsed) => lead(parsed).controlChanges ?? {};

test("a controller change is written, and read back at the right time and value", async () => {
  const parsed = parseMidiFile(await midiBytes(pieceWith({
    cc: [
      { controller: 74, value: 0, time: 0 },
      { controller: 74, value: 0.5, time: 2 },
      { controller: 74, value: 1, time: 4 },
    ],
  })));
  const cc = controllersOf(parsed);
  assert.ok(cc["74"], "controller 74 is present");
  assert.equal(cc["74"].length, 3, "all three steps, not just the first and last");
  assert.deepEqual(cc["74"].map((e) => e.time), [0, 2, 4], "at the beats they were written for");
  // 0..1 in the piece, 0..127 on the wire, and the parser normalises back.
  // 0.5 * 127 is 63.5, which rounds to 64, so it comes back as 0.5039: a
  // controller has seven bits and that is all it has. Within one 127th.
  for (const [i, want] of [0, 0.5, 1].entries()) {
    assert.ok(
      Math.abs(cc["74"][i].value - want) <= 1 / 127,
      `step ${i}: ${cc["74"][i].value} is within a 127th of ${want}`,
    );
  }
});

test("several controllers coexist, and the value range is clamped", async () => {
  const parsed = parseMidiFile(await midiBytes(pieceWith({
    cc: [
      { controller: 74, value: 0.5, time: 0 },
      { controller: 7, value: 0.6, time: 1 },
      { controller: 1, value: 1.5, time: 2 },  // over the top
      { controller: 2, value: -1, time: 3 },  // under the bottom
    ],
  })));
  const cc = controllersOf(parsed);
  assert.ok(Math.abs(cc["7"][0].value - 0.6) <= 1 / 127, "controller 7 at 0.6");
  assert.ok(cc["1"][0].value <= 1, "clamped to the top rather than wrapping");
  assert.ok(cc["2"][0].value >= 0, "and to the bottom");
});

test("a controller change lands before a note on the same beat", async () => {
  // The patch should already be set up when the note arrives, or the first note
  // of a sweep sounds with the wrong cutoff — which is exactly the bug you hear.
  const bytes = await midiBytes(pieceWith({
    cc: [{ controller: 74, value: 0, time: 0 }],
    notes: [note({ time: 0 })],
  }));
  const raw = [...bytes];
  const at = (pattern) => {
    for (let i = 0; i < raw.length - pattern.length; i++) {
      if (pattern.every((b, k) => raw[i + k] === b)) return i;
    }
    return -1;
  };
  const cc74 = at([0xb0, 74, 0]);
  const noteOn = at([0x90, 60, 102]);
  assert.ok(cc74 > 0, "the controller change is in the file");
  assert.ok(noteOn > 0, "the note is in the file");
  assert.ok(cc74 < noteOn, "and the controller comes first");
});

test("a per-entry channel overrides the track's", async () => {
  const parsed = parseMidiFile(await midiBytes(pieceWith({
    cc: [
      { controller: 74, value: 0.5, time: 0 },
      { controller: 74, value: 0.8, time: 1, channel: 5 },
    ],
  })));
  const all = Object.values(controllersOf(parsed)).flat();
  assert.equal(all.length, 2, "both written");
  // Both land on the file; which channel is asserted on the bytes, because the
  // parser keys by controller and drops the channel it read them from.
  const bytes = [...await midiBytes(pieceWith({
    cc: [
      { controller: 74, value: 0.5, time: 0 },
      { controller: 74, value: 0.8, time: 1, channel: 5 },
    ],
  }))];
  assert.ok(bytes.includes(0xb0 | 5), "the second one is on channel 5");
  assert.ok(bytes.includes(0xb0 | 0), "and the first on the track's channel 0");
});

test("cc survives a jmon -> midi -> jmon round trip", async () => {
  // The round trip is how a piece is checked for having lost anything, so a
  // field the reader cannot return is a field that silently does not exist.
  const back = await midiToJmon(await midiBytes(pieceWith({
    cc: [{ controller: 74, value: 0.5, time: 0 }],
  })));
  const cc = back.tracks[0].cc;
  assert.ok(Array.isArray(cc), "the reader gives back a cc list");
  assert.equal(cc[0].controller, 74);
  assert.ok(Math.abs(cc[0].value - 0.5) < 0.01, "value within a 127th of where it went in");
});

test("an unusable entry is dropped rather than written as silence", async () => {
  // A file that quietly omits a sweep reads as an instrument with no movement,
  // which is harder to notice than a missing one.
  const parsed = parseMidiFile(await midiBytes(pieceWith({
    cc: [
      { controller: 74, value: 0.5, time: 0 },
      { value: 0.5, time: 1 },        // no controller
      { controller: 75, time: 2 },   // no value
      null,                          // not an object
      "nonsense",
    ],
  })));
  const cc = controllersOf(parsed);
  assert.ok(cc["74"], "the good one is there");
  assert.equal(cc["75"], undefined, "the one with no value is not written as 0");
  assert.deepEqual(lead(parsed).notes.length, 1, "and the notes are untouched");
});

test("a piece with no cc is byte-for-byte what it was", async () => {
  // The common case must not change. A writer that always emits a CC 0 reset
  // would be harmless in isolation and would show up as a parameter sweep in a
  // plugin, which is not harmless.
  const plain = { format: "jmon", version: "1.0", tempo: 120, tracks: [{ label: "lead", midiChannel: 0, notes: [note()] }] };
  const withEmptyCc = { ...plain, tracks: [{ ...plain.tracks[0], cc: [] }] };
  const a = [...await midiBytes(plain)];
  const b = [...await midiBytes(withEmptyCc)];
  assert.deepEqual(b, a, "an empty cc list changes nothing");
});

test("a score cannot carry a controller change, and says so", () => {
  // MusicXML has no general controller message: <technical> holds instrument-
  // specific words, not CC numbers, so there is nowhere to put one.
  const losses = exportLosses(pieceWith({ cc: [{ controller: 74, value: 0.5, time: 0 }] }), "musicxml");
  const loss = losses.find((l) => l.field === "cc");
  assert.ok(loss, "a score reports the loss");
  assert.equal(loss.kind, "format", "and it is a wall, not a to-do");
  // And MIDI, which can carry it, must not.
  const midi = exportLosses(pieceWith({ cc: [{ controller: 74, value: 0.5, time: 0 }] }), "midi");
  assert.ok(!midi.some((l) => l.field === "cc"), "MIDI keeps it");
});
