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
`keySignatureMap`, and glissando, portamento and bend, written as a pitch-bend
sweep with the range widened via RPN 0 and read back as an articulation.

**Approximately:** velocity, to within MIDI's 7 bits. And an accelerando: a
tempo *ramp* has no MIDI message, so it is sampled as a staircase of tempo
changes on a sixteenth grid.

**Not at all:** synths, the audio graph, effects, microtuning. A MIDI file has
nowhere to put them.

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

94 tests, no dependencies and no network.

## License

GPL-3.0-or-later
