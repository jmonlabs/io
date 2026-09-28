import test from "node:test";
import assert from "node:assert/strict";

// Validate the writer's output against the official MusicXML schema.
//
// This exists because a well-formedness parse and a hand-written element-ordering
// check both passed 23 cases that the real schema rejected 6 of. The three defects
// it caught were all in the notation this package started writing recently:
//
//   - <wedge> nested inside <dynamics>, which takes only the marks p, pp, f, ff
//   - <midi-instrument> with no id, which the schema requires
//   - <tremolo type="single"/>, where the count is the element's text and an
//     empty one is not a valid mark count
//
// Every one of those is well-formed XML and is refused by MuseScore, Sibelius and
// Finale, so without this the file would never have reached a reader.
//
// Skipped, not failed, when xmllint is absent or the schema cannot be fetched: a
// missing validator is not a reason to fail a build, but it should be visible.
const XSD_URL = "https://raw.githubusercontent.com/w3c/musicxml/v3.1/schema/musicxml.xsd";
const XLINK_URL = "https://www.w3.org/1999/xlink.xsd";
const XML_URL = "https://www.w3.org/2001/xml.xsd";

let xmllint = null;
async function haveXmllint() {
  if (xmllint !== null) return xmllint;
  try {
    const out = await new Deno.Command("xmllint", { args: ["--version"], stdout: "piped", stderr: "piped" }).output();
    xmllint = out.success;
  } catch {
    xmllint = false;
  }
  return xmllint;
}

// The published schema imports two namespaces from musicxml.org, which is dead, so
// both are fetched and the imports are repointed at the local copies by absolute
// path. Validating against the unmodified schema fails on the imports alone.
let schemaDir = null;
async function haveSchema() {
  if (schemaDir !== null) return schemaDir;
  schemaDir = false;
  try {
    const dir = await Deno.makeTempDir({ prefix: "musicxml-schema-" });
    for (const [url, name] of [[XSD_URL, "musicxml.xsd"], [XML_URL, "xml.xsd"], [XLINK_URL, "xlink.xsd"]]) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      await Deno.writeTextFile(`${dir}/${name}`, await r.text());
    }
    const xsdPath = `${dir}/musicxml.xsd`;
    const patched = (await Deno.readTextFile(xsdPath))
      .replace(
        'schemaLocation="http://www.musicxml.org/xsd/xml.xsd"',
        `schemaLocation="${dir}/xml.xsd"`,
      )
      .replace(
        'schemaLocation="http://www.musicxml.org/xsd/xlink.xsd"',
        `schemaLocation="${dir}/xlink.xsd"`,
      );
    await Deno.writeTextFile(xsdPath, patched);
    schemaDir = { dir, xsdPath };
  } catch {
    schemaDir = false;
  }
  return schemaDir;
}

async function validate(xml) {
  const { dir, xsdPath } = await haveSchema();
  const file = `${dir}/case.musicxml`;
  await Deno.writeTextFile(file, xml);
  const out = await new Deno.Command("xmllint", {
    args: ["--noout", "--schema", xsdPath, file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  const valid = text.includes("validates");
  return {
    valid,
    // Only the complaints about our own file: the schema emits warnings about the
    // duplicate namespace import on every run and those are not our problem.
    errors: text.split("\n")
      .filter((l) => /validity error|fails to validate/.test(l))
      .map((l) => l.trim()),
  };
}

const N = (pitch, time, duration = 1, extra = {}) =>
  ({ pitch, duration, time, velocity: 0.8, ...extra });
const piece = (notes, track = {}, pieceExtra = {}) => ({
  title: "t", tempo: 100, timeSignature: "4/4", ...pieceExtra,
  tracks: [{ label: "L", ...track, notes }],
});

test("the writer's output validates against the MusicXML 3.1 schema", async (t) => {
  if (!await haveXmllint()) return t.skip("xmllint is not on this machine");
  if (!await haveSchema()) return t.skip("the MusicXML schema could not be fetched");

  const { default: io } = await import("../src/index.js");

  const CASES = {
    "a plain bar": piece([N(62, 0, 1), N(65, 1, 1), N(null, 2, 2)]),
    "a chord": piece([N([60, 64, 67], 0, 2), N(72, 2, 2)]),
    "notes sharing one time": piece([N(60, 0, 1), N(64, 0, 1), N(67, 0, 1), N(72, 1, 1)]),
    "a note crossing a barline": piece([N(60, 0, 2.5), N(64, 2.5, 2.5)]),
    "a looping track": piece([N(60, 0, 1), N(62, 1, 1), N(64, 2, 1), N(67, 3, 1)], { loop: true }),
    "a program number": piece([N(60, 0, 1), N(62, 1, 1)], { synth: 42 }),
    "the drum channel": piece([N(60, 0, 1), N(62, 1, 1)], { synth: 95 }),
    "a staccato": piece([
      N(60, 0, 1.75, { articulations: ["staccato"] }),
      N(62, 1.75, 2.25, { articulations: ["staccato"] }),
    ]),
    "a staccato on a sixteenth": piece([N(60, 0, 0.25, { articulations: ["staccato"] }), N(62, 0.25, 3.75)]),
    "accent, tenuto and marcato": piece([
      N(60, 0, 1, { articulations: ["accent", "tenuto"] }),
      N(62, 1, 1, { articulations: ["marcato"] }),
    ]),
    "a glissando": piece([N(60, 0, 1, { articulations: [{ type: "glissando", target: 62 }] }), N(62, 1, 1)]),
    "a portamento": piece([N(60, 0, 1, { articulations: [{ type: "portamento", target: 64 }] }), N(64, 1, 1)]),
    "a line on the last note": piece([N(60, 0, 3), N(72, 3, 1, { articulations: [{ type: "glissando", target: 74 }] })]),
    "a line across a barline": piece([
      N(60, 0, 1, { articulations: [{ type: "portamento", target: 62 }] }),
      N(62, 1, 1), N(64, 2, 1), N(65, 3, 1), N(67, 4, 1),
    ]),
    "a crescendo": piece([N(60, 0, 1, { articulations: [{ type: "crescendo" }] }), N(62, 1, 1)]),
    "a diminuendo": piece([N(60, 0, 1, { articulations: [{ type: "diminuendo" }] }), N(62, 1, 1)]),
    "a tremolo": piece([N(60, 0, 1, { articulations: [{ type: "tremolo", rate: 12, depth: 0.2 }] }), N(62, 1, 1)]),
    "every dynamic": piece([
      N(60, 0, 1, { velocity: 0.1 }), N(62, 1, 1, { velocity: 0.5 }),
      N(64, 2, 1, { velocity: 0.99 }), N(65, 3, 1, { velocity: 0.7 }),
    ]),
    "a chord with articulations": piece([N([60, 64, 67], 0, 4, { articulations: ["staccato", "accent"] })]),
    "key and metre": piece([N(60, 0, 3), N(62, 3, 1)], {}, { keySignature: "A minor", timeSignature: "3/4" }),
    "two parts": {
      title: "t", tempo: 100, timeSignature: "3/4",
      tracks: [
        { label: "A", synth: 0, clef: "bass", notes: [N(48, 0, 1), N(50, 1, 1), N(52, 2, 1)] },
        { label: "B", synth: 96, notes: [N(60, 0, 3)] },
      ],
    },
    "a piece with no tracks": { title: "t", tempo: 100, tracks: [] },
    "notes with nothing but pitch": { tempo: 100, tracks: [{ notes: [{ pitch: 60, duration: 1, time: 0 }] }] },
  };

  for (const [name, p] of Object.entries(CASES)) {
    const { valid, errors } = await validate(io.musicxml(p));
    assert.ok(valid, `${name} does not validate:\n  ${errors.join("\n  ")}`);
  }
});
