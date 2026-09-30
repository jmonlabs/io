# jmon/io

The JMON format: what it means, and how it serialises.

Standard MIDI File both directions, and MusicXML. Plus the layer
that reads a piece: tempo maps, time and key signatures, automation
channels, and what an articulation compiles to.

No dependencies and no imports outside this package. ESM source served from
GitHub via jsDelivr, no build step. It never touches audio or the DOM, so it
runs the same in Node, Deno and a browser.

## Use

```js
import io from "https://cdn.jsdelivr.net/gh/jmonlabs/io@main/src/index.js";
```

```js
const bytes = await io.midiBytes(piece);   // Uint8Array
io.midi(piece, { filename: "piece.mid" }); // a download link
const back = await io.midiToJmon(bytes);         // and back

io.musicxml(piece);                        // a MusicXML string
io.downloadMusicXML(piece);
```

Alongside the other three, [`jmon/studio`](https://github.com/jmonlabs/studio)
assembles all four and binds the injections, so this becomes `jm.midi(piece)`.

## What survives a MIDI round trip

**Exactly:** pitches, times, durations, tracks, `tempo` and `tempoMap` (one
event per change), `timeSignature` and `timeSignatureMap`, `keySignature` and
`keySignatureMap`, and a note's `tuning` and `bend` (and the glissando,
portamento and bend articulations, which compile to a bend), written as the
channel's pitch wheel with the range set via RPN 0 and read back as an
articulation. The wheel is per channel, so two notes tuned or bent differently
at the same time on one track cannot both be right: the later one is written
unbent and `validate` says so. `io.midi(piece, { mpe: true })` gives every note
a channel of its own instead, for a synth in MPE mode.

**Approximately:** velocity, to within MIDI's 7 bits. And an accelerando: a
tempo *ramp* has no MIDI message, so it is sampled as a staircase of tempo
changes on a sixteenth grid.

**Not at all:** synths, the audio graph, effects. A MIDI file has nowhere to
put them.

`midiToJmon` needs no audio library, and reports time in quarter notes rather
than seconds, so times round-trip exactly. Pass `{ parser }` to inject another
reader.

## The format layer

`io.format` is the half that reads a piece rather than writing one out.
Pure functions, useful on their own:

```js
io.format.tempoSegments(piece)        // [{ time, tempo }], always from 0
io.format.beatsToSeconds(beats, segments)   // integrates the tempo map
io.format.timeSignatureSegments(piece)
io.format.keySignatureSegments(piece) // { time, sharps, minor, key }
io.format.parseKeySignature("F# minor")     // { sharps: 3, minor: true }
io.format.automationChannels(piece)   // all three spellings, flattened
io.format.compileEvents(track)              // articulations -> modulations
io.validate(piece)                    // structural guard
```

`beatsToSeconds` is the one worth knowing about: with a constant tempo it is
`beats * 60 / tempo`, but with a tempo map each segment has to be accumulated
at its own rate, so a note straddling a change is partly at each.

`parseKeySignature` knows that a minor key takes its *relative* major's
accidentals: `Am` is 0 sharps, not 3.

## A note's pitch, beyond the keys

A pitch is a MIDI number, and three optional fields say what happens between
and around the keys. Each names what the note is, not how it is played:

```js
{ pitch: 69, duration: 2, time: 0, tuning: -0.15 }            // A4, 15 cents flat, throughout
{ pitch: 69, duration: 2, time: 2, bend: [0, -0.5] }          // A4 sliding a quarter tone down
{ pitch: 69, duration: 4, time: 4, dynamics: [0.6, 1, 0.7] }  // swells, then eases
```

- `tuning` — the note's tuning: a fixed offset from `pitch`, in semitones.
  The note sounds at `pitch + tuning`.
- `bend` — what the pitch does over the note, in semitones relative to
  `pitch + tuning`: numbers spread evenly across the duration, or anchors
  `{ time, value }` with `time` in beats from the note's start. The
  `glissando`, `portamento` and `bend` articulations are shorthands that
  compile to it; when a note has both, the field wins.
- `dynamics` — what the loudness does over the note, as multiples of its
  velocity, in the same two spellings. This is what `bow` (jmon/algo) writes.

`compileEvents` turns all three, and the articulations, into the one set of
modulations the players and the writers read. The names date from algo 3.4;
`microtuning`, `pitchEnvelope` and `amplitudeEnvelope` are still read, and
`validate` renames them in `normalized` with a warning of kind `"renamed"`.

In a MIDI file, `tuning` and `bend` are one pitch-wheel curve (see "What
survives", above): the tuning is the baseline the bend moves around.
`dynamics` is CC 11.

## Injecting it

A host that cannot `import` this package can be handed it instead. Node
refuses `https://` imports, so a package whose tests run under Node has no
other way:

```js
jm.play(piece, { Tone, sound, io });
```

Anything with `io.format`'s shape will do, which is what makes the format
layer substitutable rather than a hard dependency.

## Tests

```bash
node --test tests/*.test.js
```

157 tests, no dependencies and no network.

## License

GPL-3.0-or-later
