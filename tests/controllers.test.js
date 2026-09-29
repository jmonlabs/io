import test from "node:test";
import assert from "node:assert/strict";

// Controller moves: JMON says them in three places — `track.cc`, a note's
// `modulations`, and `midi.ccN` automation lanes — and the schema had all
// three while only the first was ever read. They now come out as one list,
// which the MIDI writer writes and a player sends to the instrument.
import { controllerEvents, noteRelativeBeats } from "../src/format/controllers.js";
import { automationChannels } from "../src/format/timeline.js";
import { midiBytes } from "../src/midi.js";
import { parseMidiFile } from "../src/midi-parser.js";

const note = (extra = {}) => ({ pitch: 60, time: 0, duration: 4, velocity: 0.8, ...extra });

test("track.cc steps come through as they are", () => {
  const track = { label: "a", notes: [], cc: [{ time: 2, controller: 1, value: 0.5 }, { time: 0, controller: 1, value: 0 }] };
  assert.deepEqual(controllerEvents(track), [
    { time: 0, type: "cc", controller: 1, value: 0 },
    { time: 2, type: "cc", controller: 1, value: 0.5 },
  ]);
});

test("a note's modulations are placed from the note's start, in MIDI units made proportions", () => {
  const track = {
    label: "a",
    notes: [note({ time: 8, modulations: [
      { type: "cc", controller: 1, value: 127, time: "4n" },
      { type: "pitchBend", value: -4096, time: "8n" },
      { type: "aftertouch", value: 64, time: 1 }, // seconds, at 120 BPM: two beats
    ] })],
  };
  assert.deepEqual(controllerEvents(track, { tempo: 120 }), [
    { time: 8.5, type: "pitchBend", value: -0.5 },
    { time: 9, type: "cc", controller: 1, value: 1 },
    { time: 10, type: "aftertouch", value: 64 / 127 },
  ]);
});

test("note values read as quarter notes", () => {
  assert.equal(noteRelativeBeats("4n"), 1);
  assert.equal(noteRelativeBeats("2n"), 2);
  assert.equal(noteRelativeBeats("8t"), 1 / 3);
  assert.equal(noteRelativeBeats("4n."), 1.5);
  assert.equal(noteRelativeBeats("1:0:240"), 4.5);
});

test("a midi.cc lane is walked in steps, from the piece or from the track", () => {
  const lane = { target: "midi.cc1", anchorPoints: [{ time: 0, value: 0 }, { time: 1, value: 1 }] };
  const fromTrack = controllerEvents({ label: "a", notes: [], automation: [lane] }, { tracks: [{ label: "a", automation: [lane] }] });
  assert.equal(fromTrack[0].value, 0);
  assert.equal(fromTrack.at(-1).time, 1);
  assert.equal(fromTrack.at(-1).value, 1);
  assert.equal(fromTrack.length, 33, "every 1/32 of a beat, both ends included");

  const piece = { automation: { tracks: { a: [lane] }, global: [{ target: "midi.cc64", anchorPoints: [{ time: 0, value: 1 }] }] } };
  const moves = controllerEvents({ label: "a", notes: [] }, piece);
  assert.equal(moves.filter((m) => m.controller === 1).length, 33);
  assert.deepEqual(moves.find((m) => m.controller === 64), { time: 0, type: "cc", controller: 64, value: 1 }, "a global lane reaches every track");
  assert.equal(controllerEvents({ label: "b", notes: [] }, piece).filter((m) => m.controller === 1).length, 0, "and a track's lane only its track");
});

test("a lane that converterHints maps onto an audio parameter is not the instrument's", () => {
  const piece = {
    converterHints: { tone: { cc1: { target: "vibrato", parameter: "depth" } } },
    automation: { global: [{ target: "midi.cc1", anchorPoints: [{ time: 0, value: 1 }] }] },
  };
  assert.deepEqual(controllerEvents({ label: "a", notes: [] }, piece), []);
});

test("a track's own automation list is an automation channel, for audio targets too", () => {
  const channels = automationChannels({ tracks: [{ label: "lead", automation: [{ target: "track.lead.volume", anchorPoints: [{ time: 0, value: -6 }] }] }] });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].trackId, "lead");
});

test("the MIDI file carries control changes, pitch bends and channel pressure from every source", async () => {
  const bytes = await midiBytes({
    format: "jmon", version: "1.0", tempo: 120,
    tracks: [{
      label: "lead", midiChannel: 0,
      notes: [note({ modulations: [{ type: "pitchBend", value: 8192, time: "4n" }, { type: "aftertouch", value: 100, time: "2n" }] })],
      automation: [{ target: "midi.cc21", anchorPoints: [{ time: 0, value: 0.5 }] }],
    }],
  });
  const parsed = parseMidiFile(bytes);
  const lead = parsed.tracks.find((t) => t.name === "lead") ?? parsed.tracks.at(-1);
  assert.ok(lead.controlChanges?.[21]?.length > 0, "the lane's CC 21");
  assert.ok(lead.pitchBends?.some((b) => b.value > 0.99), "the bend, all the way up");
  const raw = [...new Uint8Array(bytes)];
  assert.ok(raw.some((b, i) => b === 0xd0 && raw[i + 1] === 100), "channel pressure 100");
});
