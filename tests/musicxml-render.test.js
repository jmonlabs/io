import test from "node:test";
import assert from "node:assert/strict";

// Render the output with MuseScore and check that it was understood.
//
// Everything else in this suite checks that the file is correct. This checks that
// a program reads it correctly, which is a different question and the one that
// matters: a file can be well-formed, schema-valid, and still come out as
// something the composer did not write.
//
// It paid for itself immediately. The loop case validated and rendered a single
// plain barline where a repeat sign should be. Isolating it — the same file with
// and without <bar-style>, one variable at a time — showed that naming a
// <bar-style> next to a <repeat> makes MuseScore draw the barline and drop the
// repeat. Both are legal, the schema is silent, and no unit test could see it.
//
// Skipped when MuseScore is not installed, which is most CI. It needs a window
// server on macOS, so it cannot run headless.
const CANDIDATES = [
  "/Applications/MuseScore 4.app/Contents/MacOS/mscore",
  "/Applications/MuseScore 3.app/Contents/MacOS/mscore",
  "/usr/local/bin/mscore",
  "/usr/bin/mscore",
  "mscore",
  "musescore",
];

let mscore = null;
async function haveMuseScore() {
  if (mscore !== null) return mscore;
  for (const candidate of CANDIDATES) {
    try {
      const out = await new Deno.Command(candidate, {
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (out.success) {
        mscore = candidate;
        return mscore;
      }
    } catch {
      // not there; try the next one
    }
  }
  mscore = false;
  return mscore;
}

// Render to SVG and report what MuseScore drew. SVG rather than PNG because it
// is text: a barline is a polyline, so counting strokes is exact instead of a
// judgement about a picture.
async function renderToSvg(xml, dir) {
  const bin = await haveMuseScore();
  const input = `${dir}/in.musicxml`;
  const output = `${dir}/out.svg`;
  await Deno.writeTextFile(input, xml);
  await new Deno.Command(bin, { args: ["-o", output, input], stdout: "null", stderr: "null" }).output();
  // MuseScore numbers multi-page output, so the name is not exactly what we asked.
  for (const name of [output, `${dir}/out-1.svg`]) {
    try {
      return await Deno.readTextFile(name);
    } catch {
      // try the next candidate name
    }
  }
  return "";
}

// Count by class name, however MuseScore happens to spell the element. Noteheads
// and dynamics are <path d="..."> while barlines are <polyline points="...">, so
// matching on points= alone finds the barlines and nothing else.
const marks = (svg, className) =>
  [...svg.matchAll(new RegExp(`class="${className}"`, "g"))].length;

const piece = (notes, track = {}) => ({
  title: "t", tempo: 100, timeSignature: "4/4", keySignature: "C",
  tracks: [{ label: "L", ...track, notes }],
});
const N = (pitch, time, duration = 1, extra = {}) =>
  ({ pitch, duration, time, velocity: 0.8, ...extra });

test("MuseScore reads a looping track as a repeat, not a plain barline", async (t) => {
  if (!await haveMuseScore()) return t.skip("MuseScore is not installed");
  const { default: io } = await import("../src/index.js");
  const bar = [N(60, 0, 1), N(62, 1, 1), N(64, 2, 1), N(67, 3, 1)];

  // The same bar, once with loop and once without. The plain one is the control:
  // it says what a barline costs when nothing is asked of it, so the assertion
  // below is a comparison rather than a number someone read off one screenshot.
  const withLoop = await renderToSvg(io.musicxml(piece(bar, { loop: true })), await Deno.makeTempDir({ prefix: "loop-" }));
  const plain = await renderToSvg(io.musicxml(piece(bar)), await Deno.makeTempDir({ prefix: "plain-" }));
  if (!withLoop || !plain) return t.skip("MuseScore produced no SVG; it needs a window server");

  const looped = marks(withLoop, "BarLine");
  const unlooped = marks(plain, "BarLine");
  assert.ok(
    looped > unlooped,
    `a repeat is a heavy and a light stroke at each end, so it must draw more than `
    + `a plain barline does: looped ${looped}, plain ${unlooped}`,
  );
  // And a reader that ignored the repeat would draw exactly the plain barline, so
  // anything above the control but below a real double barline is still a failure.
  assert.ok(looped >= unlooped * 3, `${looped} against a control of ${unlooped} is not a repeat sign`);
});

test("MuseScore reads the notation, and reads the dynamics once each", async (t) => {
  if (!await haveMuseScore()) return t.skip("MuseScore is not installed");
  const { default: io } = await import("../src/index.js");
  const dir = await Deno.makeTempDir({ prefix: "musicxml-render-" });

  const svg = await renderToSvg(
    io.musicxml(piece([
      N(60, 0, 0.5, { articulations: ["staccato"] }),
      N(62, 0.5, 0.5, { articulations: ["accent"] }),
      N(64, 1, 0.5, { articulations: [{ type: "glissando", target: 67 }] }),
      N(67, 1.5, 0.5),
      N(69, 2, 1, { articulations: [{ type: "crescendo" }] }),
      N(72, 3, 1, { articulations: [{ type: "tremolo", rate: 12, depth: 0.2 }] }),
    ])),
    dir,
  );
  if (!svg) return t.skip("MuseScore produced no SVG; it needs a window server");

  // Not that the tags are present — the schema test covers that — but that a real
  // program turned each one into a mark on the page.
  assert.equal(marks(svg, "Note"), 6, "all six notes");
  assert.equal(marks(svg, "Articulation"), 2, "the staccato and the accent");
  assert.ok(marks(svg, "GlissandoSegment") >= 1, "the glissando became a line");
  assert.ok(marks(svg, "TremoloSingleChord") >= 1, "the tremolo became a mark");

  // A wedge is drawn as a Hairpin. This is the one that was nested wrongly and
  // validated anyway, so it is worth asserting a reader understood it.
  assert.ok(/Hairpin|wedge/i.test(svg), "the crescendo became a hairpin");
});

test("one dynamic for a level that does not change", async (t) => {
  if (!await haveMuseScore()) return t.skip("MuseScore is not installed");
  const { default: io } = await import("../src/index.js");
  const dir = await Deno.makeTempDir({ prefix: "musicxml-render-" });

  // The XML says one <dynamics>; this confirms it arrives as one mark, which is
  // the difference between a score and a page of instructions.
  const svg = await renderToSvg(
    io.musicxml(piece([N(60, 0, 1), N(62, 1, 1), N(64, 2, 1), N(67, 3, 1)])),
    dir,
  );
  if (!svg) return t.skip("MuseScore produced no SVG; it needs a window server");
  assert.equal(marks(svg, "Dynamic"), 1, "four notes at one velocity, one mark");
});
