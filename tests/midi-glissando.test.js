/**
 * MIDI export of pitch curves: glissando articulations and pitchEnvelope
 * notes must produce real pitch wheel events (plus an RPN 0 bend-range
 * setup) in the Standard MIDI File output.
 *
 * Runs standalone with `node` and under `deno test`.
 */

import assert from "node:assert";
import { midiBytes } from "../src/midi.js";

/**
 * Minimal SMF event scanner. The encoder always writes full status bytes
 * (no running status) and no sysex, so a simple walk is enough.
 */
function parseEvents(bytes) {
  const events = [];
  let pos = 14; // skip MThd
  while (pos < bytes.length) {
    assert.strictEqual(String.fromCharCode(...bytes.slice(pos, pos + 4)), "MTrk");
    const length = (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7];
    let p = pos + 8;
    const end = p + length;
    let tick = 0;
    while (p < end) {
      let delta = 0;
      while (bytes[p] & 0x80) {
        delta = (delta << 7) | (bytes[p++] & 0x7f);
      }
      delta = (delta << 7) | bytes[p++];
      tick += delta;
      const status = bytes[p++];
      if (status === 0xff) {
        const type = bytes[p++];
        let len = 0;
        while (bytes[p] & 0x80) len = (len << 7) | (bytes[p++] & 0x7f);
        len = (len << 7) | bytes[p++];
        p += len;
        events.push({ tick, status, type });
      } else {
        const kind = status & 0xf0;
        const d1 = bytes[p++];
        const d2 = (kind === 0xc0 || kind === 0xd0) ? undefined : bytes[p++];
        events.push({ tick, status, kind, d1, d2 });
      }
    }
    pos = end;
  }
  return events;
}

// Glissando from 60 to 72 (an octave — beyond MIDI's default ±2 semitones)
{
  const piece = {
    tempo: 120,
    tracks: [{
      label: "lead",
      notes: [
        { pitch: 60, time: 0, duration: 2, articulations: [{ type: "glissando", target: 72 }] },
        { pitch: 60, time: 2, duration: 1 },
      ],
    }],
  };

  const events = parseEvents(midiBytes(piece));
  const bends = events.filter((e) => e.kind === 0xe0);
  const ccs = events.filter((e) => e.kind === 0xb0);

  // RPN 0 sets bend range to 12 semitones so the octave fits
  const rpnMsb = ccs.find((e) => e.d1 === 101 && e.d2 === 0);
  const rpnLsb = ccs.find((e) => e.d1 === 100 && e.d2 === 0);
  const dataEntry = ccs.find((e) => e.d1 === 6);
  assert.ok(rpnMsb && rpnLsb && dataEntry, "expected RPN bend-range setup");
  assert.strictEqual(dataEntry.d2, 12, "bend range should cover the octave glissando");
  console.log("✓ RPN pitch-bend sensitivity sized to the curve (12 semitones)");

  assert.ok(bends.length > 10, `expected a dense bend stream, got ${bends.length}`);

  const value = (e) => (e.d2 << 7) | e.d1;
  assert.strictEqual(bends[0].tick, 0);
  assert.strictEqual(value(bends[0]), 8192, "curve starts at center");

  // Curve peaks at full upward deflection (+12 semitones at range 12)…
  const max = Math.max(...bends.map(value));
  assert.strictEqual(max, 16383, "octave up should hit full deflection");

  // …and the wheel recenters at the note end (beat 2 = tick 960)
  const atEnd = bends.filter((e) => e.tick === 960).map(value);
  assert.ok(atEnd.includes(8192), "wheel recenters at note end");
  console.log("✓ bend stream ramps to full deflection and recenters at note end");
}

// pitchEnvelope produces the same kind of bend stream (shared backend)
{
  const piece = {
    tempo: 120,
    tracks: [{
      notes: [{ pitch: 71, time: 0, duration: 1, pitchEnvelope: [0, 1] }],
    }],
  };
  const events = parseEvents(midiBytes(piece));
  const bends = events.filter((e) => e.kind === 0xe0);
  assert.ok(bends.length > 4, "pitchEnvelope should emit pitch wheel events");
  const value = (e) => (e.d2 << 7) | e.d1;
  assert.strictEqual(value(bends[0]), 8192);
  // +1 semitone at range 2 = half deflection
  const max = Math.max(...bends.map(value));
  assert.ok(Math.abs(max - (8192 + 8191 / 2)) <= 1, `expected ~half deflection, got ${max}`);
  console.log("✓ pitchEnvelope [0, 1] exports as a half-deflection bend at range 2");
}

// Plain notes emit no bend traffic
{
  const piece = {
    tempo: 120,
    tracks: [{ notes: [{ pitch: 60, time: 0, duration: 1 }] }],
  };
  const events = parseEvents(midiBytes(piece));
  assert.strictEqual(events.filter((e) => e.kind === 0xe0).length, 0);
  assert.strictEqual(events.filter((e) => e.kind === 0xb0).length, 0);
  console.log("✓ plain notes emit no pitch wheel or RPN events");
}

console.log("\nAll MIDI pitch-curve tests passed");
