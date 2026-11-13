import { test } from "node:test";
import assert from "node:assert/strict";
import { recordedTrack, controllerEvents } from "../src/index.js";

test("keys become notes, as played", () => {
  const { notes } = recordedTrack([
    { time: 0.02, type: "on", pitch: 60, velocity: 0.5 },
    { time: 0.98, type: "off", pitch: 60 },
    { time: 1, type: "on", pitch: 64, velocity: 1 },
    { time: 3.1, type: "off", pitch: 64 },
  ]);
  assert.deepEqual(notes, [
    { pitch: 60, time: 0.02, duration: 0.96, velocity: 0.5 },
    { pitch: 64, time: 1, duration: 2.1, velocity: 1 },
  ]);
});

test("a grid snaps starts and lengths, never to nothing", () => {
  const { notes } = recordedTrack([
    { time: 0.13, type: "on", pitch: 60, velocity: 0.8 },
    { time: 0.2, type: "off", pitch: 60 },
  ], { grid: 0.25 });
  assert.deepEqual(notes, [{ pitch: 60, time: 0.25, duration: 0.25, velocity: 0.8 }]);
});

test("over a loop, passes fold into it and a note stops at its end", () => {
  const { notes } = recordedTrack([
    { time: 1, type: "on", pitch: 60, velocity: 0.8 },
    { time: 2, type: "off", pitch: 60 },
    { time: 5, type: "on", pitch: 67, velocity: 0.8 }, // second pass
    { time: 6, type: "off", pitch: 67 },
    { time: -0.1, type: "on", pitch: 72, velocity: 0.8 }, // just before the downbeat
    { time: 0.2, type: "off", pitch: 72 },
  ], { loop: 4 });
  assert.deepEqual(notes.map((n) => [n.pitch, n.time, n.duration]), [[60, 1, 1], [67, 1, 1], [72, 3.9, 0.1]]);
});

test("a held note lasts until the last event", () => {
  const { notes } = recordedTrack([
    { time: 0, type: "on", pitch: 60, velocity: 0.8 },
    { time: 2, type: "cc", controller: 1, value: 0.5 },
  ]);
  assert.equal(notes[0].duration, 2);
});

test("knobs become controller steps, off the grid and without repeats", () => {
  const { cc } = recordedTrack([
    { time: 0.1, type: "cc", controller: 26, value: 0.2 },
    { time: 0.2, type: "cc", controller: 26, value: 0.2 },
    { time: 0.3, type: "cc", controller: 26, value: 0.6 },
  ], { grid: 1 });
  assert.deepEqual(cc, [{ time: 0.1, controller: 26, value: 0.2 }, { time: 0.3, controller: 26, value: 0.6 }]);
});

test("the bend goes into the notes it bends, and plays back where it was played", () => {
  const track = recordedTrack([
    { time: 0, type: "on", pitch: 60, velocity: 0.8 },
    { time: 1, type: "pitchBend", value: 0.5 },
    { time: 2, type: "off", pitch: 60 },
  ], { tempo: 60 });
  assert.deepEqual(track.notes[0].modulations, [{ type: "pitchBend", time: 1, value: 4096 }]);
  const moves = controllerEvents(track, { tempo: 60 });
  assert.deepEqual(moves.map((m) => [m.type, m.time, m.value]), [["pitchBend", 1, 0.5]]);
});
