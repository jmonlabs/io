/**
 * Timeline helpers: tempo maps and automation.
 *
 * Pure functions, no Tone.js and no DOM, so they can be tested headlessly and
 * shared by both players — which schedule differently. `music-player.js` works
 * in seconds, so it needs beats converted through the tempo map;
 * `live/player.js` works in transport ticks, so it only needs the tempo changes
 * placed on the transport and Tone does the rest.
 *
 * All times in JMON are quarter notes. `bars:beats:ticks` strings are accepted
 * everywhere a time is read.
 */

const DEFAULT_TEMPO = 120;
const TICKS_PER_BEAT = 480;

/**
 * Read a JMON time value as quarter notes.
 *
 * @param {number|string} value - Quarter notes, or a `bars:beats:ticks` string
 * @param {number} [beatsPerBar=4] - Needed only for the string form
 * @returns {number} Quarter notes
 */
export function readTime(value, beatsPerBar = 4) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string" && value.includes(":")) {
    const [bars = 0, beats = 0, ticks = 0] = value.split(":").map(Number);
    return (bars || 0) * beatsPerBar + (beats || 0) + (ticks || 0) / TICKS_PER_BEAT;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Normalise a composition's tempo into a sorted list of segments.
 *
 * There is always at least one segment starting at beat 0, so callers never
 * have to special-case a composition without a tempo map.
 *
 * @param {Object} composition - JMON composition
 * @returns {Array<{time: number, tempo: number}>} Ascending, starting at 0
 */
export function tempoSegments(composition = {}) {
  const base = composition.tempo || composition.bpm || DEFAULT_TEMPO;
  const beatsPerBar = readBeatsPerBar(composition);

  const segments = (composition.tempoMap || [])
    .filter((entry) => entry && Number.isFinite(Number(entry.tempo)))
    .map((entry) => ({
      time: Math.max(0, readTime(entry.time, beatsPerBar)),
      tempo: Number(entry.tempo),
    }))
    .sort((a, b) => a.time - b.time);

  if (segments.length === 0 || segments[0].time > 0) {
    segments.unshift({ time: 0, tempo: base });
  }

  // A later entry at the same beat wins; keeping both would create a
  // zero-length segment that contributes nothing but rounding error.
  return segments.filter((segment, i) =>
    i === segments.length - 1 || segment.time !== segments[i + 1].time
  );
}

/**
 * Convert a beat position to seconds, integrating the tempo map.
 *
 * With a constant tempo this is just `beats * 60 / tempo`. With tempo changes
 * each segment has to be accumulated at its own rate — which is why a player
 * that schedules in seconds cannot simply multiply by a single `secondsPerQN`.
 *
 * @param {number} beats - Position in quarter notes
 * @param {Array<{time: number, tempo: number}>} segments - From {@link tempoSegments}
 * @returns {number} Seconds from the start of the piece
 */
export function beatsToSeconds(beats, segments) {
  if (!Number.isFinite(beats) || beats <= 0) return 0;
  if (!segments || segments.length === 0) return beats * 60 / DEFAULT_TEMPO;

  let seconds = 0;
  for (let i = 0; i < segments.length; i++) {
    const { time, tempo } = segments[i];
    if (beats <= time) break;

    const next = segments[i + 1];
    const segmentEnd = next ? Math.min(next.time, beats) : beats;
    seconds += (segmentEnd - time) * 60 / tempo;
  }
  return seconds;
}

/** The tempo in force at a given beat. */
export function tempoAt(beats, segments) {
  let tempo = segments?.[0]?.tempo ?? DEFAULT_TEMPO;
  for (const segment of segments || []) {
    if (segment.time > beats) break;
    tempo = segment.tempo;
  }
  return tempo;
}

/** Beats per bar, from a `"4/4"`-style time signature. */
export function readBeatsPerBar(composition = {}) {
  const signature = composition.timeSignature;
  if (Array.isArray(signature) && signature.length === 2) {
    return signature[0] * (4 / signature[1]);
  }
  if (typeof signature === "string" && signature.includes("/")) {
    const [numerator, denominator] = signature.split("/").map(Number);
    if (numerator > 0 && denominator > 0) return numerator * (4 / denominator);
  }
  return 4;
}

/**
 * Flatten the automation model into one list of channels.
 *
 * JMON describes automation three ways — `automation.global`, per-track
 * `automation.tracks[id]`, and the deprecated flat `automation.events`. They
 * all reduce to the same thing: a target, and points over time.
 *
 * @param {Object} composition - JMON composition
 * @returns {Array<{id, target, scope, trackId, points: Array<{time, value}>}>}
 *   Empty when automation is absent or disabled
 */
export function automationChannels(composition = {}) {
  const automation = composition.automation;
  if (!automation || automation.enabled === false) return [];

  const beatsPerBar = readBeatsPerBar(composition);
  const channels = [];

  const push = (channel, scope, trackId) => {
    const points = (channel?.anchorPoints || [])
      .map((point) => ({
        time: Math.max(0, readTime(point.time, beatsPerBar)),
        value: Number(point.value),
      }))
      .filter((point) => Number.isFinite(point.value))
      .sort((a, b) => a.time - b.time);

    if (points.length === 0 || !channel?.target) return;
    channels.push({
      id: channel.id || `${scope}:${channel.target}`,
      target: channel.target,
      scope,
      trackId: trackId ?? channel.sequenceId,
      points,
    });
  };

  for (const channel of automation.global || []) push(channel, "global");

  for (const [trackId, list] of Object.entries(automation.tracks || {})) {
    for (const channel of list || []) push(channel, "track", trackId);
  }

  // The deprecated flat form: one event per point, grouped by target.
  if (Array.isArray(automation.events) && automation.events.length > 0) {
    const byTarget = new Map();
    for (const event of automation.events) {
      if (!event?.target) continue;
      (byTarget.get(event.target) ?? byTarget.set(event.target, []).get(event.target))
        .push({ time: event.time, value: event.value });
    }
    for (const [target, anchorPoints] of byTarget) {
      push({ id: `events:${target}`, target, anchorPoints }, "global");
    }
  }

  return channels;
}

/**
 * Split an automation target into the node it addresses and the parameter on
 * it. Targets look like `"reverb.wet"`, `"track.lead.volume"`, `"tempo"` or
 * `"midi.cc1"`.
 *
 * @param {string} target
 * @returns {{kind: 'tempo'|'track'|'node'|'midi', node?: string, param?: string, cc?: number}}
 */
export function parseAutomationTarget(target) {
  if (typeof target !== "string" || target.length === 0) {
    return { kind: "node", node: "", param: "" };
  }
  if (target === "tempo" || target === "bpm") return { kind: "tempo" };

  const parts = target.split(".");

  if (parts[0] === "midi") {
    const cc = Number(String(parts[1] || "").replace(/^cc/, ""));
    return { kind: "midi", cc: Number.isFinite(cc) ? cc : null };
  }

  if (parts[0] === "track" && parts.length >= 3) {
    return { kind: "track", node: parts.slice(1, -1).join("."), param: parts.at(-1) };
  }

  return { kind: "node", node: parts.slice(0, -1).join("."), param: parts.at(-1) };
}

/**
 * Normalise a composition's time signature into a sorted list of segments,
 * the same way {@link tempoSegments} does for tempo.
 *
 * @param {Object} composition - JMON composition
 * @returns {Array<{time: number, numerator: number, denominator: number, beatsPerBar: number}>}
 */
export function timeSignatureSegments(composition = {}) {
  const beatsPerBar = readBeatsPerBar(composition);
  const base = parseSignature(composition.timeSignature) ?? { numerator: 4, denominator: 4 };

  const segments = (composition.timeSignatureMap || [])
    .map((entry) => {
      const parsed = parseSignature(entry?.timeSignature ?? entry);
      if (!parsed) return null;
      return { time: Math.max(0, readTime(entry.time, beatsPerBar)), ...parsed };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  if (segments.length === 0 || segments[0].time > 0) {
    segments.unshift({ time: 0, ...base });
  }

  return segments
    .filter((segment, i) =>
      i === segments.length - 1 || segment.time !== segments[i + 1].time
    )
    .map((segment) => ({
      ...segment,
      beatsPerBar: segment.numerator * (4 / segment.denominator),
    }));
}

/** Read `"3/4"`, `[3, 4]` or `{ numerator, denominator }` into a pair. */
function parseSignature(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length === 2) {
    return { numerator: Number(value[0]), denominator: Number(value[1]) };
  }
  if (typeof value === "string" && value.includes("/")) {
    const [numerator, denominator] = value.split("/").map(Number);
    if (numerator > 0 && denominator > 0) return { numerator, denominator };
    return null;
  }
  if (typeof value === "object" && value.numerator && value.denominator) {
    return { numerator: Number(value.numerator), denominator: Number(value.denominator) };
  }
  return null;
}

/**
 * Resolve a `midi.ccN` automation target through the composition's
 * `converterHints.tone`, which maps a controller number onto something the
 * audio graph actually has.
 *
 * Without a hint a control change has nothing to address on the audio path, so
 * the channel is skipped. With one — `converterHints.tone.cc1 =
 * { target: "vibrato", parameter: "depth" }` — it becomes an ordinary
 * parameter target.
 *
 * @param {number} cc - Controller number
 * @param {Object} composition - JMON composition
 * @returns {{kind: 'node', node: string, param: string, range?: Array<number>}|null}
 */
export function resolveCcHint(cc, composition = {}) {
  const hints = composition.converterHints?.tone;
  if (!hints || cc === null || cc === undefined) return null;

  const hint = hints[`cc${cc}`];
  if (!hint || !hint.target) return null;

  return {
    kind: "node",
    node: hint.target,
    param: hint.parameter || "value",
    range: Array.isArray(hint.range) && hint.range.length === 2 ? hint.range : undefined,
  };
}

/**
 * Map a value from an automation channel's own range onto a target range.
 * Automation values arrive normalised (a MIDI CC is 0..1 after import), and a
 * hint may say what that should mean for the parameter it drives.
 */
export function scaleToRange(value, range) {
  if (!Array.isArray(range) || range.length !== 2) return value;
  const [min, max] = range;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return value;
  return min + value * (max - min);
}

/* --- key signatures ------------------------------------------------------ */

/**
 * Key names by position on the circle of fifths, indexed `sharps + 7`, so
 * index 7 is the key with no accidentals. Major and minor need separate
 * tables: A minor and A major are both spelled "A" but carry nothing and
 * three sharps respectively.
 */
export const KEY_NAMES_MAJOR = [
  "Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F",
  "C", "G", "D", "A", "E", "B", "F#", "C#",
];
export const KEY_NAMES_MINOR = [
  "Ab", "Eb", "Bb", "F", "C", "G", "D",
  "A", "E", "B", "F#", "C#", "G#", "D#", "A#",
];

/** Normalise a key name for lookup: "bb" and "Bb" and "B-flat" all agree. */
function normaliseKeyName(name) {
  return String(name)
    .trim()
    .replace(/[-_\s]*(flat)\b/i, "b")
    .replace(/[-_\s]*(sharp)\b/i, "#")
    .replace(/^([a-g])/i, (c) => c.toUpperCase())
    .replace(/^([A-G])B/, "$1b");
}

/**
 * Read a JMON key signature into its position on the circle of fifths.
 *
 * `"C"`, `"Am"`, `"A minor"`, `"Bb"`, `"F# minor"` and
 * `{ key: "D", scale: "minor" }` are all accepted. The mode matters: a minor
 * key takes its relative major's accidentals, so A minor is 0 and not 3.
 *
 * @param {string|Object} value - A key signature
 * @returns {{sharps: number, minor: boolean, key: string}} `sharps` is
 *   negative for flats. Falls back to C major when the name is unknown.
 */
export function parseKeySignature(value) {
  if (!value) return { sharps: 0, minor: false, key: "C" };

  let name = value;
  let minor = false;
  if (typeof value === "object") {
    name = value.key ?? value.keySignature ?? "C";
    minor = /min/i.test(String(value.scale ?? value.mode ?? ""));
  }

  const text = String(name).trim();
  if (!minor) {
    // "Am", "A minor", "a min" — but not "Ab", where the b is an accidental.
    minor = /(?:\bmin(?:or)?\b)|(?:^[A-Ga-g](?:#|b)?m$)/.test(text);
  }

  const bare = normaliseKeyName(
    text.replace(/\b(major|maj|minor|min)\b/gi, "").replace(/^([A-Ga-g](?:#|b)?)m$/, "$1"),
  );

  const table = minor ? KEY_NAMES_MINOR : KEY_NAMES_MAJOR;
  const index = table.indexOf(bare);
  if (index === -1) return { sharps: 0, minor, key: table[7] };
  return { sharps: index - 7, minor, key: bare };
}

/**
 * Normalise a composition's key signature into a sorted list of segments, the
 * same way {@link tempoSegments} and {@link timeSignatureSegments} do.
 *
 * @param {Object} composition - JMON composition
 * @returns {Array<{time: number, sharps: number, minor: boolean, key: string}>}
 */
export function keySignatureSegments(composition = {}) {
  const beatsPerBar = readBeatsPerBar(composition);
  const base = parseKeySignature(composition.keySignature || "C");

  const segments = (composition.keySignatureMap || [])
    .filter((entry) => entry && (entry.keySignature || entry.key))
    .map((entry) => ({
      time: Math.max(0, readTime(entry.time, beatsPerBar)),
      ...parseKeySignature(entry.keySignature ?? entry),
    }))
    .sort((a, b) => a.time - b.time);

  if (segments.length === 0 || segments[0].time > 0) {
    segments.unshift({ time: 0, ...base });
  }

  return segments.filter((segment, i) =>
    i === segments.length - 1 || segment.time !== segments[i + 1].time
  );
}
