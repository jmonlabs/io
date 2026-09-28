/**
 * The parts of a MusicXML document that carry expression.
 *
 * The writer used to emit notes, rests, chords, key, metre, tempo, clef, part
 * names and a title, and nothing else — no `<notations>`, no `<dynamics>`, no
 * `<repeat>`, no `<midi-instrument>`. Every expressive field in a JMON piece was
 * dropped on the way to a score, which is the same bug the MIDI writer had, one
 * package over. `validate(piece, { for: "musicxml" })` is what made it visible.
 *
 * What is deliberately not here: a pitch bend or a vibrato. Neither has an
 * agreed glyph in the notation, and inventing one would show the reader
 * something the composer did not write. `validate()` reports those two.
 */

/** The articulations on a note, whichever spelling it uses, as `{type}` objects. */
export function articulationsOf(note) {
  const raw = Array.isArray(note?.articulations)
    ? note.articulations
    : note?.articulation
    ? (typeof note.articulation === "string" ? [note.articulation] : [note.articulation])
    : [];
  // The declarative form is a mix of strings and objects — "staccato" as often
  // as { type: "staccato" } — so reading `.type` off the raw entry silently
  // drops every simple articulation.
  return raw
    .map((a) => (typeof a === "string" ? { type: a } : a))
    .filter((a) => a && typeof a.type === "string");
}

/**
 * The MusicXML dynamic a velocity asks for.
 *
 * The usual six marks, and the extremes for anything past them, because a score
 * has no more marks than that.
 *
 * @param {number} velocity - 0..1
 * @returns {string} one of pp p mp mf f ff
 */
export function dynamicFor(velocity) {
  if (velocity <= 0.2) return "pp";
  if (velocity <= 0.4) return "p";
  if (velocity <= 0.6) return "mp";
  if (velocity <= 0.8) return "mf";
  if (velocity <= 0.95) return "f";
  return "ff";
}

/**
 * How many `<divisions>` per quarter note this piece needs.
 *
 * A staccato on a sixteenth is an eighth of a beat, which is half a division
 * at the old fixed 4, so the resolution has to come from the content rather
 * than be assumed. A power of two, because that is what notation software
 * expects, and capped at 960, the usual ceiling.
 *
 * @param {Array<Object>} tracks - quantized tracks
 * @returns {number}
 */
export function divisionsFor(tracks) {
  let smallest = 1;
  for (const track of tracks ?? []) {
    for (const note of track?.notes ?? []) {
      // An onset of 0 is not a resolution constraint, hence the `|| 1`.
      smallest = Math.min(smallest, note.duration || 1, Math.abs(note.time || 0) || 1);
    }
  }
  let divisions = 4;
  while (divisions < 960 && smallest * divisions < 1) divisions *= 2;
  return divisions;
}

/**
 * A `<direction>` carrying a dynamic, or an empty string.
 *
 * Dynamic marks are directions in MusicXML, and a `<direction>` has to precede
 * the note it applies to, so this is emitted immediately before the note rather
 * than inside it.
 *
 * @param {number|null} velocity
 * @param {string} [indent]
 * @returns {string}
 */
export function dynamicDirection(velocity, indent = "      ") {
  if (typeof velocity !== "number") return "";
  const mark = dynamicFor(velocity);
  return [
    `${indent}<direction placement="below">`,
    `${indent}  <direction-type>`,
    `${indent}    <dynamics>`,
    `${indent}      <${mark}/>`,
    `${indent}    </dynamics>`,
    `${indent}  </direction-type>`,
    `${indent}</direction>`,
    "",
  ].join("\n");
}

/**
 * A crescendo or diminuendo wedge, or an empty string.
 *
 * A wedge is a sibling of `<dynamics>` inside `<direction-type>`, not a child of
 * it: `<dynamics>` takes only the marks — p, pp, f, ff — and the schema rejects
 * anything else in there. Nesting it, which is what this did first, validates as
 * well-formed XML and is refused by every reader that validates.
 *
 * A wedge has to be closed, so this emits the opening and the caller closes it at
 * the end of the phrase.
 *
 * @param {string} type - "crescendo" or "diminuendo"
 * @param {string} [indent]
 * @returns {string}
 */
export function wedgeDirection(type, indent = "      ") {
  if (type !== "crescendo" && type !== "diminuendo") return "";
  return [
    `${indent}<direction placement="below">`,
    `${indent}  <direction-type>`,
    `${indent}    <wedge type="${type}"/>`,
    `${indent}  </direction-type>`,
    `${indent}</direction>`,
    "",
  ].join("\n");
}

/** The closing half of a wedge, for the note the phrase ends on. */
export function wedgeStop(indent = "      ") {
  return [
    `${indent}<direction placement="below">`,
    `${indent}  <direction-type>`,
    `${indent}    <wedge type="stop"/>`,
    `${indent}  </direction-type>`,
    `${indent}</direction>`,
    "",
  ].join("\n");
}

/**
 * The `<notations>` element for a note, from its articulations.
 *
 * A line — a `<glissando>` or a `<slide>` — runs from the note that starts it to
 * the next note, so the caller passes back the element name of whatever is still
 * open and this closes it. A line on the last note of a piece has nowhere to run
 * to, so it is opened and closed on the same note.
 *
 * The attribute values are the ones the 3.1 DTD allows: `type` is #REQUIRED on
 * `<glissando>` and `<slide>` and its entity is start|stop, and `<tremolo>` has
 * no `number` attribute at all. line-type is left to its documented default.
 *
 * @param {Array<{type:string}>} articulations
 * @param {string|null} openLine - the element name of a line waiting to be closed
 * @param {boolean} isLastNote - there is no next note to close a line on
 * @param {string} [indent]
 * @returns {{xml:string, openLine:string|null}}
 */
export function notationsFor(articulations, openLine, isLastNote, indent = "      ") {
  const marks = [];
  const lines = [];
  let ornaments = false;

  // Close whatever the previous note started, before opening anything new.
  if (openLine) lines.push(`${indent}  <${openLine} type="stop"/>`);
  let stillOpen = null;

  for (const a of articulations ?? []) {
    switch (a?.type) {
      case "staccato": marks.push("staccato"); break;
      case "tenuto": marks.push("tenuto"); break;
      case "accent": marks.push("accent"); break;
      case "marcato": marks.push("strong-accent"); break;
      case "glissando":
      case "portamento": {
        const element = a.type === "glissando" ? "glissando" : "slide";
        if (isLastNote) {
          // Nothing follows to close it, so it is closed here instead of being
          // left dangling for a reader to guess at.
          lines.push(`${indent}  <${element} type="start"/>`);
          lines.push(`${indent}  <${element} type="stop"/>`);
        } else {
          lines.push(`${indent}  <${element} type="start"/>`);
          stillOpen = element;
        }
        break;
      }
      case "tremolo": ornaments = true; break;
      default: break;
    }
  }

  const body = [...lines];
  if (ornaments) {
    body.push(`${indent}  <ornaments>`);
    // The count is the element's text, not an attribute: <tremolo> has simple
    // content, and an empty one is not a valid mark count.
    body.push(`${indent}    <tremolo type="single">3</tremolo>`);
    body.push(`${indent}  </ornaments>`);
  }
  if (marks.length) {
    body.push(`${indent}  <articulations>`);
    for (const m of marks) body.push(`${indent}    <${m}/>`);
    body.push(`${indent}  </articulations>`);
  }
  if (!body.length) return { xml: "", openLine: null };
  return { xml: `${indent}<notations>\n${body.join("\n")}\n${indent}</notations>\n`, openLine: stillOpen };
}

/**
 * The `<score-part>` instrument, when the track names a program number.
 *
 * A score has no notion of a sampler, so a name is left out; a number is a
 * MIDI program and every reader understands it.
 *
 * The id is required by the schema, and a score conventionally names the
 * instrument after the part it plays in.
 *
 * @param {number|string} synth
 * @param {string} [partId]
 * @param {string} [indent]
 * @returns {string}
 */
export function midiInstrumentFor(synth, partId = "P1", indent = "      ") {
  if (typeof synth !== "number" || !Number.isFinite(synth)) return "";
  const program = Math.max(1, Math.min(128, Math.round(synth) + 1)); // 0-based -> 1-based
  // Program 96 is the GM drum kit, and a score says so with channel 10.
  const channel = program === 96 ? 10 : 1;
  return [
    `${indent}<midi-instrument id="${partId}-I1">`,
    `${indent}  <midi-channel>${channel}</midi-channel>`,
    `${indent}  <midi-program>${program}</midi-program>`,
    `${indent}</midi-instrument>`,
    "",
  ].join("\n");
}

/**
 * A right-hand repeat barline, for a track that loops.
 *
 * No `<bar-style>`. The DTD allows one, the file is legal with it, and MuseScore
 * accepts it — and then draws a plain barline and drops the repeat. Emitted
 * without, it draws the light-heavy barline and the two dots, which is the point.
 * The repeat implies its own barline anyway, and naming the style here would
 * collide with the one place a piece really wants it: the final barline.
 *
 * @param {string} [indent]
 * @returns {string}
 */
export function repeatRight(indent = "      ") {
  return [
    `${indent}<barline location="right">`,
    `${indent}  <repeat direction="forward" times="2"/>`,
    `${indent}</barline>`,
    "",
  ].join("\n");
}

/**
 * A left-hand repeat, opening the piece for a looping track.
 *
 * @param {string} [indent]
 * @returns {string}
 */
export function repeatLeft(indent = "      ") {
  return [
    `${indent}<barline location="left">`,
    `${indent}  <repeat direction="backward" times="2"/>`,
    `${indent}</barline>`,
    "",
  ].join("\n");
}
