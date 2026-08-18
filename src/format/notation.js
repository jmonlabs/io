/**
 * deriveVisualFromArticulations.js
 *
 * Shared helper to derive visual rendering hints from declarative note.articulations[].
 * Normalizes articulation entries, resolves precedence among accent-like marks, and
 * extracts stroke and gliss/portamento hints.
 *
 * Usage:
 *   import { deriveVisualFromArticulations } from './deriveVisualFromArticulations.js';
 *   const hints = deriveVisualFromArticulations(note.articulations);
 *   // hints.has -> Set of articulation types
 *   // hints.resolved -> { staccato, accent, tenuto, marcato }
 *   // hints.stroke -> { direction: 'up', style: 'roll' } | null
 *   // hints.gliss -> { type: 'glissando'|'portamento', target, curve?, text? } | null
 */

/**
 * Normalize the articulations array to an array of objects { type, ...params }
 * @param {Array<string|{type:string,[key:string]:any}>|null|undefined} articulations
 * @returns {Array<{type:string,[key:string]:any}>}
 */
export function normalizeArticulations(articulations) {
  const out = [];
  if (!Array.isArray(articulations)) return out;
  for (const a of articulations) {
    if (typeof a === 'string') {
      out.push({ type: a });
    } else if (a && typeof a === 'object' && typeof a.type === 'string') {
      out.push({ ...a });
    }
  }
  return out;
}

/**
 * Resolve accent-like mark precedence and coexistence.
 * Rules:
 * - marcato supersedes accent (do not emit accent if marcato is present)
 * - staccato can coexist with others
 * - tenuto can coexist (commonly with accent, but we follow simple inclusion)
 *
 * @param {Set<string>} types
 * @returns {{staccato:boolean, accent:boolean, tenuto:boolean, marcato:boolean}}
 */
function resolveAccentPrecedence(types) {
  const staccato = types.has('staccato');
  const marcato = types.has('marcato');
  const tenuto = types.has('tenuto');
  // accent suppressed when marcato present
  const accent = !marcato && types.has('accent');
  return { staccato, accent, tenuto, marcato };
}

/**
 * Extract stroke (arpeggio/arpeggiate/strum) direction/style hint.
 * Supports:
 * - { type: 'arpeggio'|'stroke', direction?: 'up'|'down', style?: 'roll'|'brush' }
 * - legacy: { type: 'arpeggiate' } is also accepted
 * @param {Array<{type:string,[key:string]:any}>} arts
 * @returns {{ direction:'up'|'down', style:'roll'|'brush' }|null}
 */
function extractStrokeHint(arts) {
  // Priority: explicit 'stroke' over 'arpeggio' (and legacy 'arpeggiate')
  const stroke =
    arts.find((a) => a.type === 'stroke') ||
    arts.find((a) => a.type === 'arpeggio') ||
    arts.find((a) => a.type === 'arpeggiate');
  if (!stroke) return null;
  const dir = (typeof stroke.direction === 'string' && stroke.direction.toLowerCase() === 'down') ? 'down' : 'up';
  const style = (typeof stroke.style === 'string' && stroke.style.toLowerCase() === 'brush') ? 'brush' : 'roll';
  return { direction: dir, style };
}

/**
 * Extract a single gliss/portamento hint.
 * Supports entries like: { type: 'glissando'|'portamento', target?: number, curve?: string }
 * The target is a MIDI integer; consumers can convert to renderer-specific key formats.
 * @param {Array<{type:string,[key:string]:any}>} arts
 * @returns {{ type:'glissando'|'portamento', target?:number, curve?:string, text?:string }|null}
 */
function extractGlissHint(arts) {
  const a = arts.find((x) => x.type === 'glissando' || x.type === 'portamento');
  if (!a) return null;
  const text = a.type === 'portamento' ? 'port.' : 'gliss.';
  const out = { type: a.type, text };
  if (typeof a.target === 'number') out.target = a.target;
  if (typeof a.curve === 'string') out.curve = a.curve;
  return out;
}

/**
 * Main helper to derive renderer hints from declarative articulations.
 * @param {Array<string|{type:string,[key:string]:any}>|null|undefined} articulations
 * @returns {{
 *   has: Set<string>,
 *   resolved: {staccato:boolean, accent:boolean, tenuto:boolean, marcato:boolean},
 *   stroke: {direction:'up'|'down', style:'roll'|'brush'}|null,
 *   gliss: { type:'glissando'|'portamento', target?:number, curve?:string, text?:string }|null
 * }}
 */
export function deriveVisualFromArticulations(articulations) {
  const arts = normalizeArticulations(articulations);
  const has = new Set(arts.map((a) => a.type));

  // Accent-like marks
  const resolved = resolveAccentPrecedence(has);

  // Stroke and gliss hints
  const stroke = extractStrokeHint(arts);
  const gliss = extractGlissHint(arts);

  return {
    has,
    resolved,
    stroke,
    gliss,
  };
}

/**
 * Convenience: return a "primary" articulation type useful for quick glyph decisions
 * Priority order (highest → lowest): marcato, accent, tenuto, staccato
 * @param {Array<string|{type:string,[key:string]:any}>|null|undefined} articulations
 * @returns {'marcato'|'accent'|'tenuto'|'staccato'|null}
 */
export function getPrimaryAccent(articulations) {
  const arts = normalizeArticulations(articulations);
  const types = new Set(arts.map((a) => a.type));
  if (types.has('marcato')) return 'marcato';
  if (types.has('accent')) return 'accent';
  if (types.has('tenuto')) return 'tenuto';
  if (types.has('staccato')) return 'staccato';
  return null;
}
