/**
 * Tempo maps and automation.
 *
 * This is the logic behind `tempoMap` and `automation` now being followed by
 * the players. It lives apart from them precisely so it can be tested without
 * a browser: both players share it, and they schedule differently —
 * music-player in seconds, live/player in transport ticks.
 *
 * node:test + assert. Run with: node --test tests/timeline.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  readTime,
  readBeatsPerBar,
  tempoSegments,
  beatsToSeconds,
  tempoAt,
  automationChannels,
  parseAutomationTarget,
} from "../src/format/timeline.js";

/* --- reading times ------------------------------------------------------- */

test("readTime passes numbers through and parses bars:beats:ticks", () => {
  assert.equal(readTime(3.5), 3.5);
  assert.equal(readTime(0), 0);
  assert.equal(readTime("0:0:0"), 0);
  assert.equal(readTime("1:0:0"), 4, "one bar of 4/4 is four quarter notes");
  assert.equal(readTime("2:1:240"), 9.5);
});

test("readTime honours a non-4/4 bar length", () => {
  assert.equal(readTime("1:0:0", 3), 3);
  assert.equal(readTime("2:1:0", 7), 15);
});

test("readBeatsPerBar reads both time-signature spellings", () => {
  assert.equal(readBeatsPerBar({}), 4);
  assert.equal(readBeatsPerBar({ timeSignature: "3/4" }), 3);
  assert.equal(readBeatsPerBar({ timeSignature: "6/8" }), 3);
  assert.equal(readBeatsPerBar({ timeSignature: [7, 8] }), 3.5);
});

/* --- tempo segments ------------------------------------------------------ */

test("a piece without a tempoMap still yields one segment", () => {
  assert.deepEqual(tempoSegments({ tempo: 96 }), [{ time: 0, tempo: 96 }]);
  assert.deepEqual(tempoSegments({}), [{ time: 0, tempo: 120 }]);
});

test("tempo segments are sorted and anchored at beat zero", () => {
  const segments = tempoSegments({
    tempo: 120,
    tempoMap: [{ time: 8, tempo: 240 }, { time: 4, tempo: 60 }],
  });
  assert.deepEqual(segments, [
    { time: 0, tempo: 120 },
    { time: 4, tempo: 60 },
    { time: 8, tempo: 240 },
  ]);
});

test("a tempoMap that starts late keeps the piece tempo before it", () => {
  const segments = tempoSegments({ tempo: 100, tempoMap: [{ time: 16, tempo: 80 }] });
  assert.equal(segments[0].time, 0);
  assert.equal(segments[0].time === 0 && segments[0].tempo, 100);
});

test("two entries on the same beat collapse to the later one", () => {
  const segments = tempoSegments({
    tempo: 120,
    tempoMap: [{ time: 4, tempo: 60 }, { time: 4, tempo: 90 }],
  });
  assert.equal(segments.filter((s) => s.time === 4).length, 1);
  assert.equal(segments.at(-1).tempo, 90);
});

test("tempoMap entries accept bars:beats:ticks", () => {
  const segments = tempoSegments({ tempo: 120, tempoMap: [{ time: "2:0:0", tempo: 60 }] });
  assert.deepEqual(segments.at(-1), { time: 8, tempo: 60 });
});

/* --- integrating the map ------------------------------------------------- */

test("with one tempo, integration is the flat calculation", () => {
  // This is the property that matters for not regressing every existing piece:
  // no tempoMap must behave exactly as `beats * 60 / tempo` did.
  for (const tempo of [60, 90, 120, 144]) {
    const segments = tempoSegments({ tempo });
    for (const beats of [0, 0.5, 1, 3.25, 16]) {
      assert.equal(
        beatsToSeconds(beats, segments),
        beats * 60 / tempo,
        `tempo ${tempo}, beat ${beats}`,
      );
    }
  }
});

test("each segment accumulates at its own rate", () => {
  const segments = tempoSegments({
    tempo: 120,
    tempoMap: [{ time: 4, tempo: 60 }, { time: 8, tempo: 240 }],
  });

  // 4 beats at 120 = 2s; then 4 beats at 60 = 4s; then beats at 240 = 0.25s each.
  assert.equal(beatsToSeconds(0, segments), 0);
  assert.equal(beatsToSeconds(2, segments), 1);
  assert.equal(beatsToSeconds(4, segments), 2);
  assert.equal(beatsToSeconds(8, segments), 6);
  assert.equal(beatsToSeconds(10, segments), 6.5);
});

test("integration is monotonic and starts at zero", () => {
  const segments = tempoSegments({
    tempo: 100,
    tempoMap: [{ time: 3, tempo: 40 }, { time: 7, tempo: 200 }, { time: 11, tempo: 90 }],
  });

  assert.equal(beatsToSeconds(0, segments), 0);
  assert.equal(beatsToSeconds(-5, segments), 0, "negative beats clamp to the start");

  let previous = 0;
  for (let beat = 0.5; beat <= 20; beat += 0.5) {
    const seconds = beatsToSeconds(beat, segments);
    assert.ok(seconds > previous, `time went backwards at beat ${beat}`);
    previous = seconds;
  }
});

test("a duration is the difference of two integrated positions", () => {
  // A note straddling a tempo change is not `duration * secondsPerQN` at
  // either rate — it is part of each.
  const segments = tempoSegments({ tempo: 120, tempoMap: [{ time: 4, tempo: 60 }] });
  const onset = 3;
  const length = 2; // crosses the change at beat 4

  const seconds = beatsToSeconds(onset + length, segments) - beatsToSeconds(onset, segments);
  assert.equal(seconds, 0.5 + 1, "one beat at 120 plus one beat at 60");
});

test("tempoAt reports the tempo in force", () => {
  const segments = tempoSegments({ tempo: 120, tempoMap: [{ time: 4, tempo: 60 }] });
  assert.equal(tempoAt(0, segments), 120);
  assert.equal(tempoAt(3.9, segments), 120);
  assert.equal(tempoAt(4, segments), 60);
  assert.equal(tempoAt(99, segments), 60);
});

/* --- automation ---------------------------------------------------------- */

const channel = (id, target, points) => ({
  id, target, anchorPoints: points.map(([time, value]) => ({ time, value })),
});

test("automation is empty when absent or switched off", () => {
  assert.deepEqual(automationChannels({}), []);
  assert.deepEqual(automationChannels({ automation: { enabled: false, global: [channel("a", "tempo", [[0, 120]])] } }), []);
});

test("global channels are collected with sorted points", () => {
  const channels = automationChannels({
    automation: { global: [channel("filter", "reverb.wet", [[8, 1], [0, 0], [4, 0.5]])] },
  });

  assert.equal(channels.length, 1);
  assert.equal(channels[0].target, "reverb.wet");
  assert.equal(channels[0].scope, "global");
  assert.deepEqual(channels[0].points.map((p) => p.time), [0, 4, 8]);
});

test("per-track channels carry their track id", () => {
  const channels = automationChannels({
    automation: { tracks: { lead: [channel("vol", "track.lead.volume", [[0, -12], [4, 0]])] } },
  });

  assert.equal(channels[0].scope, "track");
  assert.equal(channels[0].trackId, "lead");
});

test("the deprecated flat events form is grouped by target", () => {
  const channels = automationChannels({
    automation: {
      events: [
        { target: "reverb.wet", time: 0, value: 0 },
        { target: "reverb.wet", time: 4, value: 1 },
        { target: "tempo", time: 8, value: 90 },
      ],
    },
  });

  assert.equal(channels.length, 2, "one channel per distinct target");
  const wet = channels.find((c) => c.target === "reverb.wet");
  assert.deepEqual(wet.points.map((p) => p.value), [0, 1]);
});

test("channels without points or without a target are dropped", () => {
  const channels = automationChannels({
    automation: {
      global: [
        channel("empty", "reverb.wet", []),
        { id: "untargeted", anchorPoints: [{ time: 0, value: 1 }] },
        channel("ok", "reverb.wet", [[0, 1]]),
      ],
    },
  });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].id, "ok");
});

test("anchor point times accept bars:beats:ticks", () => {
  const channels = automationChannels({
    automation: { global: [channel("a", "reverb.wet", [["1:0:0", 1]])] },
  });
  assert.equal(channels[0].points[0].time, 4);
});

/* --- target parsing ------------------------------------------------------ */

test("targets resolve to the thing they address", () => {
  assert.deepEqual(parseAutomationTarget("tempo"), { kind: "tempo" });
  assert.deepEqual(parseAutomationTarget("bpm"), { kind: "tempo" });
  assert.deepEqual(parseAutomationTarget("reverb.wet"), { kind: "node", node: "reverb", param: "wet" });
  assert.deepEqual(parseAutomationTarget("track.lead.volume"), { kind: "track", node: "lead", param: "volume" });
  assert.deepEqual(parseAutomationTarget("midi.cc1"), { kind: "midi", cc: 1 });
});

test("a dotted node id survives target parsing", () => {
  assert.deepEqual(
    parseAutomationTarget("bus.a.reverb.wet"),
    { kind: "node", node: "bus.a.reverb", param: "wet" },
  );
});

test("target parsing does not throw on nonsense", () => {
  assert.doesNotThrow(() => parseAutomationTarget(""));
  assert.doesNotThrow(() => parseAutomationTarget(null));
  assert.doesNotThrow(() => parseAutomationTarget("nodot"));
});

/* --- what the MIDI importer produces ------------------------------------- */

test("a midiToJmon-shaped automation channel is understood", async () => {
  // The importer emits { id, target: "midi.cc1", anchorPoints: [{time, value}] }
  // with times in quarter notes.
  const channels = automationChannels({
    automation: {
      global: [{
        id: "cc1",
        target: "midi.cc1",
        anchorPoints: [{ time: 0, value: 0 }, { time: 2, value: 0.5 }],
      }],
    },
  });

  assert.equal(channels.length, 1);
  assert.equal(parseAutomationTarget(channels[0].target).kind, "midi");
});

/* --- time signature maps ------------------------------------------------- */

test("a piece without a timeSignatureMap yields one segment", async () => {
  const { timeSignatureSegments } = await import("../src/format/timeline.js");
  assert.deepEqual(timeSignatureSegments({}), [
    { time: 0, numerator: 4, denominator: 4, beatsPerBar: 4 },
  ]);
  assert.equal(timeSignatureSegments({ timeSignature: "3/4" })[0].beatsPerBar, 3);
});

test("time signature segments sort and compute beats per bar", async () => {
  const { timeSignatureSegments } = await import("../src/format/timeline.js");
  const segments = timeSignatureSegments({
    timeSignature: "4/4",
    timeSignatureMap: [{ time: 12, timeSignature: "5/4" }, { time: 8, timeSignature: "7/8" }],
  });

  assert.deepEqual(segments.map((s) => s.time), [0, 8, 12]);
  assert.equal(segments[1].beatsPerBar, 3.5, "7/8 is three and a half quarter notes");
  assert.equal(segments[2].beatsPerBar, 5);
});

test("time signatures parse from strings, pairs and objects", async () => {
  const { timeSignatureSegments } = await import("../src/format/timeline.js");
  const forms = [
    { timeSignatureMap: [{ time: 4, timeSignature: "6/8" }] },
    { timeSignatureMap: [{ time: 4, timeSignature: [6, 8] }] },
    { timeSignatureMap: [{ time: 4, timeSignature: { numerator: 6, denominator: 8 } }] },
  ];
  for (const piece of forms) {
    const segment = timeSignatureSegments(piece).at(-1);
    assert.equal(segment.numerator, 6);
    assert.equal(segment.denominator, 8);
  }
});

/* --- CC hints ------------------------------------------------------------ */

test("a midi.cc target resolves through converterHints", async () => {
  const { resolveCcHint, scaleToRange } = await import("../src/format/timeline.js");
  const piece = {
    converterHints: { tone: { cc1: { target: "vibrato", parameter: "depth", range: [0, 0.8] } } },
  };

  const hint = resolveCcHint(1, piece);
  assert.deepEqual(hint, { kind: "node", node: "vibrato", param: "depth", range: [0, 0.8] });
  assert.equal(scaleToRange(0.5, hint.range), 0.4);
});

test("an unhinted CC resolves to nothing, so the channel is skipped", async () => {
  const { resolveCcHint } = await import("../src/format/timeline.js");
  assert.equal(resolveCcHint(7, { converterHints: { tone: { cc1: { target: "x" } } } }), null);
  assert.equal(resolveCcHint(1, {}), null);
  assert.equal(resolveCcHint(null, {}), null);
});

test("a hint without a range leaves values untouched", async () => {
  const { resolveCcHint, scaleToRange } = await import("../src/format/timeline.js");
  const hint = resolveCcHint(1, { converterHints: { tone: { cc1: { target: "filter" } } } });
  assert.equal(hint.param, "value", "parameter defaults sensibly");
  assert.equal(scaleToRange(0.5, hint.range), 0.5);
});
