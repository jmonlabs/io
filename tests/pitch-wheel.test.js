/**
 * A note's tuning and bend, as one pitch wheel curve: what the MIDI writer
 * draws, and what it must leave out.
 *
 * Run with: node --test tests/pitch-wheel.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { pitchWheelCurves, pitchWheelEvents, pitchWheelPlan, wheelRangeFor, WHEEL_CENTRE } from "../src/pitch-wheel.js";
import { compilePerformanceTrack } from "../src/format/performance.js";
import { midiBytes } from "../src/midi.js";
import { parseMidiFile } from "../src/midi-parser.js";

const n = (pitch, time, duration = 1, extra = {}) => ({ pitch, time, duration, velocity: 0.8, ...extra });
const bendsOf = (events) => events.filter((e) => (e.bytes[0] & 0xf0) === 0xe0);
const valueOf = (e) => (e.bytes[2] << 7) | e.bytes[1];

test("a tuning alone is a curve that holds its value for the whole note", () => {
  const [curve] = pitchWheelCurves([n(60, 2, 4, { tuning: -0.15 })]);
  assert.deepEqual(curve.anchors, [{ time: 2, value: -15 }, { time: 6, value: -15 }]);
  assert.deepEqual([curve.start, curve.end], [2, 6]);
});

test("a bend is relative to the tuning: the two add up", () => {
  const [curve] = pitchWheelCurves([n(60, 0, 2, { tuning: 0.5, bend: [0, 1] })]);
  assert.deepEqual(curve.anchors.map((a) => a.value), [50, 150]);
  const [old] = pitchWheelCurves([n(60, 0, 2, { microtuning: 0.5, pitchEnvelope: [0, 1] })]);
  assert.deepEqual(old.anchors, curve.anchors, "the old names are read the same way");
});

test("the bend field wins over a glissando or bend articulation on the same note", () => {
  const both = compilePerformanceTrack({ notes: [n(60, 0, 2, { bend: [0, 0.5], articulations: [{ type: "glissando", target: 72 }, { type: "bend", amount: 200 }] })] });
  const pitch = both.modulations.filter((m) => m.type === "pitch");
  assert.equal(pitch.length, 1);
  assert.equal(pitch[0].subtype, "envelope");
  assert.deepEqual(pitch[0].anchors.map((a) => a.value), [0, 50]);
});

test("tunings that overlap on one channel are left out, unless they agree", () => {
  const apart = pitchWheelPlan(pitchWheelCurves([n(60, 0, 1, { tuning: 0.1 }), n(62, 1, 1, { tuning: -0.1 })]), () => 0);
  assert.equal(apart.dropped.length, 0, "one after the other, both are written");

  const together = pitchWheelPlan(pitchWheelCurves([n(60, 0, 2, { tuning: 0.1 }), n(64, 1, 2, { tuning: -0.1 })]), () => 0);
  assert.deepEqual(together.written.map((c) => c.index), [0]);
  assert.deepEqual(together.dropped.map((c) => c.index), [1], "the later one cannot be right on the same wheel");

  const chord = pitchWheelPlan(pitchWheelCurves([n(60, 0, 2, { tuning: -0.25 }), n(64, 0, 2, { tuning: -0.25 }), n(67, 0.5, 2, { tuning: -0.25 })]), () => 0);
  assert.equal(chord.dropped.length, 0, "a chord tuned the same way holds one wheel value");

  const glide = pitchWheelPlan(pitchWheelCurves([n(60, 0, 2, { bend: [0, 1] }), n(64, 1, 2, { tuning: 1 })]), () => 0);
  assert.equal(glide.dropped.length, 1, "a moving wheel agrees with nothing");

  const channels = pitchWheelPlan(pitchWheelCurves([n(60, 0, 2, { tuning: 0.1 }), n(64, 1, 2, { tuning: -0.1 })]), (i) => i);
  assert.equal(channels.dropped.length, 0, "on channels of their own, as MPE gives them, nothing overlaps");
});

test("the wheel is set before the note, and recentred once the last note holding it ends", () => {
  const notes = [n(60, 0, 2, { tuning: -0.25 }), n(64, 1, 2, { tuning: -0.25 })];
  const { written } = pitchWheelPlan(pitchWheelCurves(notes), () => 0);
  const events = pitchWheelEvents(written, 480);
  const bends = bendsOf(events);
  assert.ok(bends[0].sortOrder < 1 && bends[0].tick === 0, "set before the note-on at tick 0");
  const centred = bends.filter((e) => valueOf(e) === WHEEL_CENTRE);
  assert.equal(centred.length, 1, "one recentre, not one per note");
  assert.equal(centred[0].tick, 3 * 480, "at the end of the second note, not the first");
  assert.ok(events.some((e) => e.bytes[1] === 6 && e.bytes[2] === 2), "a sensitivity of 2 semitones is enough for a quarter tone");
});

test("the range fits the widest curve, and MPE fixes it instead", () => {
  assert.equal(wheelRangeFor(pitchWheelCurves([n(60, 0, 1, { tuning: 0.2 })])), 2);
  assert.equal(wheelRangeFor(pitchWheelCurves([n(60, 0, 1, { bend: [0, 7] })])), 7);
  assert.equal(wheelRangeFor(pitchWheelCurves([n(60, 0, 1, { bend: [0, 40] })])), 24, "capped at MIDI's usual ceiling");
  const events = pitchWheelEvents(pitchWheelPlan(pitchWheelCurves([n(60, 0, 1, { tuning: 0.2 })]), () => 3).written, 480, { range: 48, sensitivity: false });
  assert.ok(!events.some((e) => (e.bytes[0] & 0xf0) === 0xb0), "no RPN when the caller has sent it");
});

test("a file written without mpe carries the tuning on the track's channel, and with mpe keeps the bend too", () => {
  const parse = (bytes) => parseMidiFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const piece = { tempo: 100, tracks: [{ label: "L", synth: 69, notes: [n(60, 0, 2, { tuning: 0.25, bend: [0, 1] }), n(64, 3, 1, { tuning: -0.25 })] }] };
  const plain = parse(midiBytes(piece));
  const bends = plain.tracks.reduce((all, t) => all + (t.pitchBends?.length ?? 0), 0);
  assert.ok(bends > 3, "a sweep for the first note and a step for the second");
  const mpe = parse(midiBytes(piece, { mpe: true }));
  const mpeBends = mpe.tracks.reduce((all, t) => all + (t.pitchBends?.length ?? 0), 0);
  assert.ok(mpeBends > 3, "the bend curve is drawn in MPE as well, on the note's own channel");
});
