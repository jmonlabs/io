/* jmon-to-midi.js - Convert JMON format to Standard MIDI File (no external deps) */
import { compilePerformanceTrack as compileEvents } from "./format/performance.js";
import {
    tempoSegments,
    timeSignatureSegments,
    keySignatureSegments,
    automationChannels,
    parseAutomationTarget,
} from "./format/timeline.js";

// --- Built-in MIDI binary encoder ---

function writeVarLen(value) {
    const bytes = [];
    bytes.push(value & 0x7f);
    value >>= 7;
    while (value > 0) {
        bytes.push((value & 0x7f) | 0x80);
        value >>= 7;
    }
    return bytes.reverse();
}

function writeUint16(value) {
    return [(value >> 8) & 0xff, value & 0xff];
}

function writeUint32(value) {
    return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function writeString(str) {
    return Array.from(str, c => c.charCodeAt(0));
}

function encodeTrack(events) {
    const data = [];
    let lastTick = 0;

    // Sort events by tick, then by type (note-off before note-on at same tick)
    events.sort((a, b) => a.tick - b.tick || a.sortOrder - b.sortOrder);

    for (const evt of events) {
        const delta = evt.tick - lastTick;
        data.push(...writeVarLen(delta));
        data.push(...evt.bytes);
        lastTick = evt.tick;
    }

    // End of track
    data.push(0x00, 0xff, 0x2f, 0x00);
    return data;
}

function buildMidiFile(composition) {
    const bpm = composition.tempo || composition.bpm || 120;
    const ticksPerBeat = 480;
    const rawTracks = composition.tracks || [];
    const tracksArray = Array.isArray(rawTracks)
        ? rawTracks
        : (rawTracks && typeof rawTracks === 'object' ? Object.values(rawTracks) : []);

    const trackChunks = [];

    // Track 0: tempo track. One set-tempo meta event per segment of the
    // composition's tempoMap, so a piece that changes tempo exports as one —
    // it used to flatten to a single rate at tick 0. Segments come from the
    // same helper the players integrate, so the file agrees with playback.
    // With no tempoMap there is exactly one segment and the output is
    // unchanged.
    // A tempo *ramp* — automation targeting `tempo` — has no MIDI message of
    // its own, so it is approximated as a staircase of set-tempo events.
    // Built first because a ramp anchor is the more specific instruction and
    // wins at a tick the tempoMap also names: that is the order the players
    // schedule them in, and the file has to agree with what you hear.
    const tempoEvents = buildTempoRampEvents(composition, ticksPerBeat);
    const rampTicks = new Set(tempoEvents.map(event => event.tick));

    for (const segment of tempoSegments(composition)) {
        const tick = Math.round(segment.time * ticksPerBeat);
        if (rampTicks.has(tick)) continue;
        const microsecondsPerBeat = Math.round(60000000 / segment.tempo);
        tempoEvents.push({
            tick,
            sortOrder: -1,
            bytes: [0xff, 0x51, 0x03,
                (microsecondsPerBeat >> 16) & 0xff,
                (microsecondsPerBeat >> 8) & 0xff,
                microsecondsPerBeat & 0xff]
        });
    }

    // Time signature (0x58). The writer used to emit none, so an exported
    // piece opened in 4/4 whatever its metre — while the importer read the
    // event back, making the round trip lossy in one direction only.
    for (const segment of timeSignatureSegments(composition)) {
        tempoEvents.push({
            tick: Math.round(segment.time * ticksPerBeat),
            sortOrder: -3,
            bytes: [0xff, 0x58, 0x04,
                segment.numerator,
                Math.round(Math.log2(segment.denominator)),
                24,  // MIDI clocks per metronome click
                8]   // 32nd notes per quarter note
        });
    }

    // Key signature (0x59). `sf` is signed: negative counts flats.
    for (const segment of keySignatureSegments(composition)) {
        tempoEvents.push({
            tick: Math.round(segment.time * ticksPerBeat),
            sortOrder: -3,
            bytes: [0xff, 0x59, 0x02, segment.sharps & 0xff, segment.minor ? 1 : 0]
        });
    }

    // Title
    const title = composition.title || composition.metadata?.title || '';
    if (title) {
        const titleBytes = writeString(title);
        tempoEvents.push({
            tick: 0,
            sortOrder: -4,
            bytes: [0xff, 0x03, ...writeVarLen(titleBytes.length), ...titleBytes]
        });
    }

    trackChunks.push(encodeTrack(tempoEvents));

    // Channel assignment: respect track.channel (or track.midiChannel), else
    // auto-assign sequentially, skipping channel 9 (drums). Accept 1-indexed
    // `channel: 10` as the conventional GM drum channel and normalize to 9.
    let autoChannel = 0;
    const resolveChannel = (track) => {
        const raw = track.channel ?? track.midiChannel;
        if (typeof raw === 'number') {
            if (raw === 10) return 9;           // GM 1-indexed drum channel
            if (raw >= 0 && raw <= 15) return raw;
        }
        if (autoChannel === 9) autoChannel++;   // skip drums slot
        const c = autoChannel;
        autoChannel = (autoChannel + 1) % 16;
        return c;
    };

    // Note tracks
    for (const track of tracksArray) {
        const notesSrc = Array.isArray(track.events) ? track.events
            : (Array.isArray(track.notes) ? track.notes
                : (Array.isArray(track) ? track : []));
        const safeNotes = Array.isArray(notesSrc) ? notesSrc : [];

        const events = [];
        const label = track.label || track.name || '';
        if (label) {
            const labelBytes = writeString(label);
            events.push({
                tick: 0,
                sortOrder: -2,
                bytes: [0xff, 0x03, ...writeVarLen(labelBytes.length), ...labelBytes]
            });
        }

        const channel = resolveChannel(track);

        // Add time to notes if missing
        let currentTime = 0;
        const notesWithTime = safeNotes.map(note => {
            const t = note.time !== undefined ? note.time : currentTime;
            currentTime = t + (note.duration || 1);
            return { ...note, time: t };
        });

        for (const note of notesWithTime) {
            if (note.pitch === null || note.pitch === undefined) continue; // rest
            // Accept scalar pitch or array (chord from Chain branching etc.)
            const pitches = Array.isArray(note.pitch) ? note.pitch : [note.pitch];
            const velocity = Math.round((note.velocity || 0.8) * 127);
            const startTick = Math.round((note.time || 0) * ticksPerBeat);
            const endTick = Math.round(((note.time || 0) + (note.duration || 1)) * ticksPerBeat);

            for (const p of pitches) {
                if (typeof p !== 'number') continue;
                events.push({
                    tick: startTick,
                    sortOrder: 1,
                    bytes: [0x90 | channel, p, velocity]
                });
                events.push({
                    tick: endTick,
                    sortOrder: 0, // note-off sorts before note-on at same tick
                    bytes: [0x80 | channel, p, 0]
                });
            }
        }

        // Pitch curves (glissando, portamento, bend, pitch envelopes) compile
        // to cents anchors; render them as MIDI pitch wheel events.
        events.push(...buildPitchBendEvents(notesWithTime, channel, ticksPerBeat));

        trackChunks.push(encodeTrack(events));
    }

    // Assemble file
    const numTracks = trackChunks.length;
    const fileBytes = [];

    // Header: MThd
    fileBytes.push(...writeString('MThd'));
    fileBytes.push(...writeUint32(6)); // header length
    fileBytes.push(...writeUint16(1)); // format 1 (multi-track)
    fileBytes.push(...writeUint16(numTracks));
    fileBytes.push(...writeUint16(ticksPerBeat));

    // Track chunks
    for (const trackData of trackChunks) {
        fileBytes.push(...writeString('MTrk'));
        fileBytes.push(...writeUint32(trackData.length));
        fileBytes.push(...trackData);
    }

    return new Uint8Array(fileBytes);
}

/**
 * Render compiled pitch curves (anchors in cents) as MIDI pitch wheel events.
 *
 * Emits an RPN 0 (pitch bend sensitivity) setup sized to the widest curve on
 * the track — MIDI's ±2 semitone default would clip wider glissandi — then
 * samples each curve's linear segments and recenters the wheel at note end.
 *
 * @param {Array<Object>} notes - track notes with resolved numeric times
 * @param {number} channel - MIDI channel (0-15)
 * @param {number} ticksPerBeat
 * @returns {Array<{tick:number,sortOrder:number,bytes:number[]}>}
 */
/**
 * Approximate a tempo ramp as a staircase of set-tempo events.
 *
 * An accelerando is written as automation targeting `tempo`, which the players
 * ramp continuously on `Transport.bpm`. Standard MIDI File has no such
 * message — a tempo is a step that holds until the next one — so a curve can
 * only be sampled. Steps land on a sixteenth-note grid, and a step is skipped
 * when it would repeat the previous rounded tempo, so a slow ramp does not
 * fill the track with identical events.
 *
 * @param {Object} composition - JMON composition
 * @param {number} ticksPerBeat
 * @returns {Array<{tick: number, sortOrder: number, bytes: Array<number>}>}
 */
function buildTempoRampEvents(composition, ticksPerBeat) {
    const ramps = automationChannels(composition)
        .filter(channel => parseAutomationTarget(channel.target).kind === 'tempo');
    if (ramps.length === 0) return [];

    const events = [];
    const stepBeats = 0.25;
    const written = new Set();   // one tempo per tick, so ramps don't stack

    const emit = (beat, bpm) => {
        const tick = Math.round(beat * ticksPerBeat);
        if (written.has(tick)) return;
        written.add(tick);
        const microsecondsPerBeat = Math.round(60000000 / bpm);
        events.push({
            tick,
            sortOrder: -1,
            bytes: [0xff, 0x51, 0x03,
                (microsecondsPerBeat >> 16) & 0xff,
                (microsecondsPerBeat >> 8) & 0xff,
                microsecondsPerBeat & 0xff]
        });
    };

    for (const ramp of ramps) {
        for (let k = 0; k < ramp.points.length; k++) {
            const from = ramp.points[k];
            const to = ramp.points[k + 1];
            emit(from.time, from.value);
            if (!to || to.time <= from.time) continue;

            let previous = Math.round(from.value);
            const span = to.time - from.time;
            for (let beat = from.time + stepBeats; beat < to.time; beat += stepBeats) {
                const value = from.value + (to.value - from.value) * ((beat - from.time) / span);
                const rounded = Math.round(value);
                if (rounded === previous) continue;
                emit(beat, rounded);
                previous = rounded;
            }
        }
    }

    return events;
}

function buildPitchBendEvents(notes, channel, ticksPerBeat) {
    let pitchMods = [];
    try {
        const perf = compileEvents({ events: notes });
        pitchMods = (perf.modulations || []).filter(
            m => m.type === 'pitch' && Array.isArray(m.anchors) && m.anchors.length > 0
        );
    } catch (_) {
        return [];
    }
    if (pitchMods.length === 0) return [];

    const maxCents = Math.max(
        ...pitchMods.flatMap(m => m.anchors.map(a => Math.abs(a.value)))
    );
    const rangeSemitones = Math.min(24, Math.max(2, Math.ceil(maxCents / 100)));
    const centerValue = 8192;

    const events = [];

    // RPN 0,0 = pitch bend sensitivity, in semitones (MSB) + cents (LSB),
    // then deselect the RPN so later CCs can't change it accidentally.
    const rpn = [[101, 0], [100, 0], [6, rangeSemitones], [38, 0], [101, 127], [100, 127]];
    // Array sort is stable, so equal tick/sortOrder preserves RPN sequence.
    rpn.forEach(([cc, value]) => {
        events.push({ tick: 0, sortOrder: -1, bytes: [0xb0 | channel, cc, value] });
    });

    const toBendValue = (cents) => {
        const v = centerValue + Math.round((cents / (rangeSemitones * 100)) * (centerValue - 1));
        return Math.max(0, Math.min(16383, v));
    };
    const pushBend = (tick, value, sortOrder) => {
        events.push({
            tick,
            sortOrder,
            bytes: [0xe0 | channel, value & 0x7f, (value >> 7) & 0x7f]
        });
    };

    // Sample each linear segment finely enough to sound continuous.
    const stepTicks = Math.max(1, Math.round(ticksPerBeat / 16));

    for (const mod of pitchMods) {
        const anchors = mod.anchors;
        // Initial value lands between note-off (0) and note-on (1) at the
        // same tick so the wheel is set before the note sounds.
        pushBend(Math.round(anchors[0].time * ticksPerBeat), toBendValue(anchors[0].value), 0.5);

        for (let k = 1; k < anchors.length; k++) {
            const a = anchors[k - 1];
            const b = anchors[k];
            const aTick = Math.round(a.time * ticksPerBeat);
            const bTick = Math.round(b.time * ticksPerBeat);
            let lastValue = toBendValue(a.value);
            for (let tick = aTick + stepTicks; tick < bTick; tick += stepTicks) {
                const frac = (tick - aTick) / (bTick - aTick);
                const value = toBendValue(a.value + (b.value - a.value) * frac);
                if (value === lastValue) continue;
                pushBend(tick, value, 2);
                lastValue = value;
            }
            // The arrival value lands on the note boundary, where the
            // recenter (0.25) also sits. Order it just ahead of the recenter
            // rather than at 2, or the wheel is left off-centre for whatever
            // follows.
            const isArrival = k === anchors.length - 1;
            const endValue = toBendValue(b.value);
            if (endValue !== lastValue || bTick === aTick) {
                pushBend(bTick, endValue, isArrival ? 0.2 : 2);
            }
        }

        // Recenter so the next note starts clean. sortOrder 0.25 keeps the
        // reset ahead of a following curve's initial value at the same tick.
        const last = anchors[anchors.length - 1];
        if (toBendValue(last.value) !== centerValue) {
            pushBend(Math.round(mod.end * ticksPerBeat), centerValue, 0.25);
        }
    }

    return events;
}

// --- Public API ---

export class Midi {
    static midiToNoteName(midi) {
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(midi / 12) - 1;
        const noteIndex = midi % 12;
        return noteNames[noteIndex] + octave;
    }
    static convert(composition) {
        const bpm = composition.tempo || composition.bpm || 120;
        const timeSignature = composition.timeSignature || '4/4';
        const rawTracks = composition.tracks || [];
        const tracksArray = Array.isArray(rawTracks)
            ? rawTracks
            : (rawTracks && typeof rawTracks === 'object' ? Object.values(rawTracks) : []);

        return {
            header: { bpm, timeSignature },
            tracks: tracksArray.map(track => {
                const label = track.label || track.name;
                const notesSrc = Array.isArray(track.events) ? track.events
                                : (Array.isArray(track.notes) ? track.notes
                                : (Array.isArray(track) ? track : []));
                const safeNotes = Array.isArray(notesSrc) ? notesSrc : [];
                const perf = compileEvents({ events: safeNotes }, { tempo: bpm, timeSignature });

                const notes = safeNotes.map(note => ({
                    pitch: note.pitch,
                    noteName: (typeof note.pitch === 'number') ? Midi.midiToNoteName(note.pitch) : note.pitch,
                    time: note.time,
                    duration: note.duration,
                    velocity: note.velocity || 0.8
                }));

                return {
                    label,
                    notes,
                    modulations: (perf && Array.isArray(perf.modulations)) ? perf.modulations : []
                };
            })
        };
    }
}

/**
 * Encode a JMON composition as a Standard MIDI File and return the raw bytes.
 * DOM-free — safe to call from Node, Deno, and notebook kernels.
 *
 * @param {Object} composition - The JMON composition
 * @returns {Uint8Array} The SMF byte stream
 */
export function midiBytes(composition) {
    return buildMidiFile(composition);
}

/**
 * Encode a JMON composition as a base64-encoded MIDI file. Useful for
 * embedding in data: URLs or handing to notebook MIDI players that expect
 * a string payload. DOM-free.
 *
 * @param {Object} composition - The JMON composition
 * @returns {string} Base64-encoded SMF bytes (no data: prefix)
 */
export function midiBase64(composition) {
    const bytes = buildMidiFile(composition);
    return bytesToBase64(bytes);
}

/**
 * Build a MIME bundle for displaying a MIDI file in a notebook. Includes
 * both `audio/midi` (for hosts that can render it) and `text/html` (a
 * data-URL download link, which JupyterLab and most kernels *will* render).
 * Hand the result to `jm.env.present()` to display inline.
 *
 * @param {Object} composition - The JMON composition
 * @param {Object} [options]
 * @param {string} [options.filename='composition.mid'] - Download filename
 * @param {string} [options.label] - Link label; defaults to the filename
 * @returns {Object} MIME bundle: {audio/midi, text/html, text/plain}
 *
 * @example
 * jm.env.present(jm.converters.midiDisplay(composition));
 */
export function midiDisplay(composition, options = {}) {
    const {
        filename = "composition.mid",
        label,
    } = options;
    const bytes = buildMidiFile(composition);
    const b64 = bytesToBase64(bytes);
    const sizeKb = (bytes.length / 1024).toFixed(1);
    const linkLabel = label || `⬇ ${filename} (${sizeKb} KB)`;
    // Inline, no external CSS — works in any kernel that renders text/html.
    const html =
        `<a href="data:audio/midi;base64,${b64}" download="${escapeHtml(filename)}" ` +
        `style="display:inline-block;padding:6px 12px;background:#2b2b2b;color:#fff;` +
        `border-radius:4px;text-decoration:none;font-family:sans-serif;font-size:13px">` +
        `${escapeHtml(linkLabel)}</a>`;
    return {
        "audio/midi": b64,
        "text/html": html,
        "text/plain": `MIDI (${bytes.length} bytes)`,
    };
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Build an interactive in-notebook MIDI player. Returns a MIME bundle
 * whose `text/html` content is an iframe hosting the `html-midi-player`
 * web component (Magenta + Tone.js, loaded from jsDelivr) pointed at a
 * `data:audio/midi;base64,...` URL. Gives actual play/pause/seek inside
 * Jupyter without any extension.
 *
 * The player is embedded inside an iframe `srcdoc` for two reasons:
 *   1. CDN scripts load in a clean document context, avoiding conflicts
 *      with whatever Jupyter has already loaded in the parent page.
 *   2. CSP / script restrictions on the parent page don't affect us.
 *
 * @param {Object} composition - The JMON composition
 * @param {Object} [options]
 * @param {boolean} [options.visualizer=true] - Render the Magenta piano-roll
 *   visualizer above the player controls.
 * @param {string} [options.soundFont] - URL of a soundfont. Defaults to
 *   Magenta's general-MIDI soundfont hosted on Google Cloud Storage.
 * @param {number} [options.height] - iframe height in pixels. Defaults to
 *   220 (visualizer + controls) or 80 (controls only).
 * @returns {Object} MIME bundle: { text/html, audio/midi, text/plain }
 *
 * @example
 * jm.env.present(jm.converters.midiPlayer(composition));
 */
export function midiPlayer(composition, options = {}) {
    const {
        visualizer = true,
        soundFont = "https://storage.googleapis.com/magentadata/js/soundfonts/sgm_plus",
        height: iframeHeight = visualizer ? 220 : 80,
    } = options;

    const bytes = buildMidiFile(composition);
    const b64 = bytesToBase64(bytes);
    const dataUrl = `data:audio/midi;base64,${b64}`;

    // html-midi-player bundles tone.js + @magenta/music into one script.
    // Version 1.5.0 is the current stable as of writing.
    const playerScript =
        "https://cdn.jsdelivr.net/combine/" +
        "npm/tone@14.7.77," +
        "npm/@magenta/music@1.23.1/es6/core.js," +
        "npm/focus-visible@5," +
        "npm/html-midi-player@1.5.0";

    const visualizerEl = visualizer
        ? `<midi-visualizer type="piano-roll" id="vis" src="${dataUrl}"></midi-visualizer>`
        : "";
    const playerEl = `<midi-player src="${dataUrl}" sound-font="${soundFont}"${visualizer ? ' visualizer="#vis"' : ""}></midi-player>`;

    const doc =
        `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<script src="${playerScript}"></script>` +
        `<style>` +
        `body{margin:0;padding:4px;font-family:system-ui,sans-serif;background:transparent}` +
        `midi-player{display:block;width:100%;margin-top:4px;` +
        `--midi-player-font-family:system-ui,sans-serif}` +
        `midi-visualizer{display:block;width:100%;height:120px;` +
        `--midi-visualizer-active-note-color:#0af}` +
        `</style></head><body>${visualizerEl}${playerEl}</body></html>`;

    // srcdoc needs double-quotes escaped so we can wrap it in double-quotes.
    const srcdoc = doc.replace(/"/g, "&quot;");
    const html =
        `<iframe srcdoc="${srcdoc}" ` +
        `style="width:100%;height:${iframeHeight}px;border:none;display:block" ` +
        `sandbox="allow-scripts allow-same-origin"></iframe>`;

    return {
        "text/html": html,
        "audio/midi": b64,
        "text/plain": `MIDI player (${bytes.length} bytes)`,
    };
}

/**
 * Minimal, dependency-free Uint8Array -> base64.
 * Works in browsers (btoa), Node (Buffer), and Deno (btoa). We avoid
 * importing `Buffer` so the core library stays environment-agnostic.
 */
function bytesToBase64(bytes) {
    // btoa is available in browsers and Deno; Node 16+ exposes it too.
    if (typeof btoa === "function") {
        // Build a binary string in chunks to avoid blowing the call stack on
        // large buffers when using String.fromCharCode(...bytes).
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    }
    // Last-resort fallback for hosts without btoa or Buffer.
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "";
    let i = 0;
    while (i < bytes.length) {
        const b1 = bytes[i++];
        const b2 = i < bytes.length ? bytes[i++] : 0;
        const b3 = i < bytes.length ? bytes[i++] : 0;
        const triplet = (b1 << 16) | (b2 << 8) | b3;
        output += chars[(triplet >> 18) & 0x3f];
        output += chars[(triplet >> 12) & 0x3f];
        output += i - 1 > bytes.length ? "=" : chars[(triplet >> 6) & 0x3f];
        output += i > bytes.length ? "=" : chars[triplet & 0x3f];
    }
    return output;
}

/**
 * Convert a JMON composition to a MIDI output. In a browser this returns
 * an `<a>` download link (the original behavior). In headless environments
 * it returns the raw `Uint8Array` so callers can pipe it to a file or
 * notebook display helper.
 *
 * For an explicit, environment-agnostic API prefer `midiBytes()` or
 * `midiBase64()`.
 *
 * @param {Object} composition - The JMON composition
 * @param {Object} [options] - Options
 * @param {string} [options.filename='composition.mid'] - Filename used for
 *   the download link text (browser only)
 * @returns {HTMLAnchorElement|Uint8Array}
 *
 * @example
 * display(jm.converters.midi(composition));
 * display(jm.converters.midi(composition, { filename: "my-song.mid" }));
 */
export function midi(composition, options = {}) {
    const { filename = 'composition.mid' } = options;
    const bytes = buildMidiFile(composition);

    // Headless path: no DOM, return the bytes directly.
    if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") {
        return bytes;
    }

    const blob = new Blob([bytes], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.textContent = `Download ${filename}`;
    return a;
}
