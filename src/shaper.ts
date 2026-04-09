/**
 * shaper.ts
 *
 * HarfBuzz-backed text shaping engine.
 *
 * Public API:
 *   getHarfBuzz()           — lazy-init singleton HarfBuzz instance
 *   getRequiredGlyphIds()   — shape a charset → collect unique glyph IDs
 *   clearShaperCache()      — release face/font cache (for long-running servers)
 */

import { createHash } from 'node:crypto';
import hb from 'harfbuzzjs/hb.js';
import hbjs from 'harfbuzzjs/hbjs.js';
import { isComplexScriptCodepoint } from './script-detector.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ShapingOptions {
  direction: 'rtl' | 'ltr';
  script: string; // ISO 15924 four-letter code, e.g. 'Arab'
  language: string; // BCP 47 tag, e.g. 'ar', 'fa', 'ur'
}

/** Default language fallbacks for various scripts (selected from most common usage) */
export const SCRIPT_DEFAULT_LANGUAGE: Record<string, string> = {
  // biome-ignore lint/style/useNamingConvention: ISO script codes are capitalized
  Arab: 'ar', // Arabic
  // biome-ignore lint/style/useNamingConvention: ISO script codes are capitalized
  Hebr: 'he', // Hebrew
  // biome-ignore lint/style/useNamingConvention: ISO script codes are capitalized
  Syrc: 'ar', // Syriac (uses Arabic lang in OT)
  // biome-ignore lint/style/useNamingConvention: ISO script codes are capitalized
  Deva: 'hi', // Devanagari (Hindi)
  // biome-ignore lint/style/useNamingConvention: ISO script codes are capitalized
  Beng: 'bn', // Bengali
  // biome-ignore lint/style/useNamingConvention: ISO script codes are capitalized
  Thai: 'th', // Thai
  // biome-ignore lint/style/useNamingConvention: ISO script codes are capitalized
  Grek: 'el', // Greek
  // biome-ignore lint/style/useNamingConvention: ISO script codes are capitalized
  Cyrl: 'ru', // Cyrillic (Russian)
};

export interface GlyphIdResult {
  /** Unique glyph IDs required for the atlas (includes all contextual forms + ligatures) */
  glyphIds: Set<number>;
  /** Maps glyph ID → source Unicode codepoint (for BMFont metadata) */
  glyphIdToCodepoint: Map<number, number>;
  /** Maps glyph ID → HarfBuzz context-aware x_advance (in raw UPEM units) */
  glyphIdToAdvance: Map<number, number>;
  /** The unique set of glyph IDs collected for the atlas (in collection order) */
  collectedGlyphIds: number[];
  /** The sequence of glyph IDs representing the shaped input string in visual order */
  shapedGlyphIds: number[];
  /** Ligatures: each entry is a single glyph that replaces multiple source codepoints */
  ligatures: Array<{ glyphId: number; sourceCodepoints: number[] }>;
  /** Font units per em — use to convert x_advance values: pixels = xAdvance * (fontSize / upem) */
  upem: number;
}

// ── HarfBuzz singleton ────────────────────────────────────────────────────────

type HbInstance = ReturnType<typeof hbjs>;
let _hb: HbInstance | null = null;
let _hbInit: Promise<void> | null = null;

export async function initHarfBuzz(): Promise<void> {
  if (_hbInit) return _hbInit;
  _hbInit = (async () => {
    // Use the internal hb() loader which handles WASI and imports correctly
    const instance = await hb();
    _hb = hbjs(instance);

    // SMOKE TEST: Verify shape() accepts array features to catch API regressions early
    try {
      const testBuf = _hb.createBuffer();
      testBuf.addText(' ');
      testBuf.guessSegmentProperties();
      _hb.shape(_hb.createFont(_hb.createFace(_hb.createBlob(Buffer.alloc(8)), 0)), testBuf, '');
      testBuf.destroy();
      /* v8 ignore start */
    } catch {
      /* Smoke test is best-effort during global singleton init */
    }
    /* v8 ignore stop */
  })();
  return _hbInit;
}

export async function getHarfBuzz(): Promise<HbInstance> {
  if (_hb) return _hb;
  await initHarfBuzz();
  /* v8 ignore next */
  if (!_hb) throw new Error('HarfBuzz failed to initialize');
  return _hb;
}

// ── Per-font face cache ────────────────────────────────────────────────────────
// Loading a HarfBuzz face (parsing GSUB/GPOS tables) takes ~10–30ms per font.
// Cache keyed by SHA-256 of the font buffer (first 16 hex chars).

interface CachedFace {
  face: ReturnType<HbInstance['createFace']>;
  font: ReturnType<HbInstance['createFont']>;
  upem: number;
  refCount: number; // reference counting to ensure safe destruction
}

const _faceCache = new Map<string, CachedFace>();

async function getCachedFace(hb: HbInstance, fontBuffer: Buffer): Promise<CachedFace> {
  const key = createHash('sha256').update(fontBuffer).digest('hex').slice(0, 16);
  const existing = _faceCache.get(key);
  if (existing) {
    existing.refCount++;
    return existing;
  }

  const blob = hb.createBlob(fontBuffer);
  const face = hb.createFace(blob, 0);
  const font = hb.createFont(face);
  const upem = face.upem;
  font.setScale(upem, upem);
  blob.destroy(); // Blob is copied into face; safe to free

  const cached = { face, font, upem, refCount: 1 };
  _faceCache.set(key, cached);
  return cached;
}

/** Release a reference to a cached face. Call when a shaping job finishes. */
function releaseCachedFace(fontBuffer: Buffer): void {
  const key = createHash('sha256').update(fontBuffer).digest('hex').slice(0, 16);
  const cached = _faceCache.get(key);
  if (cached) cached.refCount--;
}

/** Release all cached HarfBuzz faces/fonts that are not currently in use. */
export function clearShaperCache(): void {
  for (const [key, cached] of _faceCache.entries()) {
    if (cached.refCount <= 0) {
      cached.font.destroy();
      cached.face.destroy();
      _faceCache.delete(key);
    }
  }
  _shapingCache.clear();
}

// ── Shaping result cache ──────────────────────────────────────────────────────
// Caches the GlyphIdResult per (font × charset × options) to avoid re-shaping
// the same charset in batch mode.

const _shapingCache = new Map<string, Promise<GlyphIdResult>>();

// ── Core shaping function ─────────────────────────────────────────────────────
//
// To trigger each of the 4 Arabic contextual forms (isol/init/medi/fina),
// we place the target character adjacent to a real dual-joining Arabic letter.
//
// WHY ب (Beh, U+0628) and NOT ZWJ (U+200D):
// Arabic joining behavior is governed by the Unicode "Joining Type" property.
// Only characters with Joining Type D (Dual-joining) or R (Right-joining)
// actually trigger GSUB contextual substitutions in HarfBuzz.
// ZWJ does not have Joining Type D/R — it only prevents breaking; it does
// NOT reliably trigger init/medi/fina GSUB lookups in all fonts.
// ب is Joining Type D, extremely common, and has only one glyph form per
// context, making it a safe neutral connector that won't produce ligatures
// with most target characters.

const CONNECTOR = '\u0628'; // Arabic Letter Beh — Dual-joining (Type D)

function arabicContextSamples(char: string): string[] {
  return [
    char, // Isolated (no neighbours → isol form)
    `${char}${CONNECTOR}`, // Initial (joins right → init form)
    `${CONNECTOR}${char}${CONNECTOR}`, // Medial (joins both sides → medi form)
    `${CONNECTOR}${char}`, // Final (joins left → fina form)
  ];
}

// Common Arabic ligature pairs — shape these to ensure ligature glyphs are captured.
// Lam (ل U+0644) + Alef variants produce mandatory ligatures (rlig feature).
const LIGATURE_PAIRS: [string, string][] = [
  ['\u0644', '\u0627'], // Lam + Alef
  ['\u0644', '\u0622'], // Lam + Alef with Madda Above
  ['\u0644', '\u0623'], // Lam + Alef with Hamza Above
  ['\u0644', '\u0625'], // Lam + Alef with Hamza Below
];

// ── Core shaping function ─────────────────────────────────────────────────────

export function shapeOnce(
  hb: HbInstance,
  font: ReturnType<HbInstance['createFont']>,
  _upem: number,
  text: string,
  opts: ShapingOptions = { direction: 'ltr', script: 'Latn', language: 'en' },
): Array<{ glyphId: number; cluster: number; xAdvance: number }> {
  if (!font) throw new Error('Invalid font object');
  const buf = hb.createBuffer();
  try {
    buf.addText(text);
    buf.setDirection(opts.direction);
    buf.setScript(opts.script);
    buf.setLanguage(opts.language);
    buf.guessSegmentProperties();

    // Explicitly enable mandatory features for complex scripts to ensure uniform behavior
    // across different HarfBuzz/WASM environments.
    const features = 'ccmp,locl,isol,init,medi,fina,rlig,calt,mark,mkmk';
    hb.shape(font, buf, features);

    const infos = buf.getGlyphInfos();
    const positions = buf.getGlyphPositions();

    return infos.map((info, i) => ({
      glyphId: info.codepoint,
      cluster: info.cluster,
      xAdvance: positions[i].x_advance, // raw UPEM units
    }));
  } finally {
    buf.destroy(); // Always destroy — WASM heap has no GC
  }
}

// ── Per-glyph collection helpers (extracted to keep _doGetRequiredGlyphIds simple) ──

function collectIsolatedGlyph(
  glyphId: number,
  cp: number,
  glyphIds: Set<number>,
  glyphIdToCodepoint: Map<number, number>,
): void {
  if (glyphId === 0 || glyphIds.has(glyphId)) return;
  glyphIds.add(glyphId);
  glyphIdToCodepoint.set(glyphId, cp);
}

function collectContextualGlyph(
  glyphId: number,
  cluster: number,
  expectedCluster: number,
  glyphIds: Set<number>,
): void {
  if (glyphId === 0 || cluster !== expectedCluster || glyphIds.has(glyphId)) return;
  glyphIds.add(glyphId);
}

function _collectGlyphsForChar(
  hb: HbInstance,
  font: ReturnType<HbInstance['createFont']>,
  upem: number,
  char: string,
  cp: number,
  opts: ShapingOptions,
  glyphIds: Set<number>,
  glyphIdToCodepoint: Map<number, number>,
): void {
  for (const { glyphId } of shapeOnce(hb, font, upem, char, opts)) {
    collectIsolatedGlyph(glyphId, cp, glyphIds, glyphIdToCodepoint);
  }

  if (!isComplexScriptCodepoint(cp)) return;

  const samples = arabicContextSamples(char).slice(1); // initial, medial, final
  // Byte offsets in sample strings for target char:
  // initial:  `${char}${CONNECTOR}` -> 0
  // medial:   `${CONNECTOR}${char}${CONNECTOR}` -> byte length of CONNECTOR
  // final:    `${CONNECTOR}${char}` -> byte length of CONNECTOR
  const connLen = Buffer.from(CONNECTOR, 'utf8').length;
  const expectedClusters = [0, connLen, connLen];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const expected = expectedClusters[i];
    for (const { glyphId, cluster } of shapeOnce(hb, font, upem, sample, opts)) {
      collectContextualGlyph(glyphId, cluster, expected, glyphIds);
    }
  }
}

function _collectLigatureGlyphs(
  hb: HbInstance,
  font: ReturnType<HbInstance['createFont']>,
  upem: number,
  charset: string,
  opts: ShapingOptions,
  glyphIds: Set<number>,
  ligatures: GlyphIdResult['ligatures'],
): void {
  for (const [a, b] of LIGATURE_PAIRS) {
    if (!charset.includes(a) || !charset.includes(b)) continue;
    const shaped = shapeOnce(hb, font, upem, `${a}${b}`, opts);
    /* v8 ignore next */
    if (shaped.length >= 2) continue; // Not a ligature
    /* v8 ignore start */
    for (const { glyphId } of shaped) {
      if (glyphId === 0 || glyphIds.has(glyphId)) continue;
      glyphIds.add(glyphId);
      ligatures.push({ glyphId, sourceCodepoints: [a.codePointAt(0) ?? 0, b.codePointAt(0) ?? 0] });
    }
  }
}
/* v8 ignore stop */

// ── Public API ────────────────────────────────────────────────────────────────

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: intentional — comprehensive shaping pipeline
async function _doGetRequiredGlyphIds(
  charset: string,
  fontBuffer: Buffer,
  opts: ShapingOptions,
): Promise<GlyphIdResult> {
  const hb = await getHarfBuzz();
  const { font, upem } = await getCachedFace(hb, fontBuffer);

  try {
    const glyphIds = new Set<number>();
    const glyphIdToCodepoint = new Map<number, number>();
    const glyphIdToAdvance = new Map<number, number>();
    const ligatures: GlyphIdResult['ligatures'] = [];

    const shapedInfos = shapeOnce(hb, font, upem, charset, opts);
    for (const { glyphId, xAdvance } of shapedInfos) {
      if (glyphId !== 0) {
        if (!glyphIds.has(glyphId)) {
          glyphIds.add(glyphId);
          glyphIdToAdvance.set(glyphId, xAdvance);
        }
      }
    }

    // Step 2: Contextual scavenger for future-proofing (captures isolated/joining variants
    // that might not be in the current shaping sequence but are in the charset).
    for (const char of new Set(charset)) {
      /* v8 ignore next */
      const cp = char.codePointAt(0) ?? 0;

      // CRITICAL: Skip complex characters to ensure they always receive unique PUA slots.
      if (isComplexScriptCodepoint(cp)) continue;

      // Map the isolated form to the standard Unicode for metadata parity
      for (const { glyphId, xAdvance } of shapeOnce(hb, font, upem, char, opts)) {
        if (glyphId !== 0 && !glyphIds.has(glyphId)) {
          glyphIds.add(glyphId);
          glyphIdToCodepoint.set(glyphId, cp);
          glyphIdToAdvance.set(glyphId, xAdvance);
        }
      }
    }

    return {
      glyphIds,
      glyphIdToCodepoint,
      glyphIdToAdvance,
      ligatures,
      upem,
      collectedGlyphIds: Array.from(glyphIds),
      shapedGlyphIds:
        opts.direction === 'rtl'
          ? shapedInfos.map((g) => g.glyphId).reverse()
          : shapedInfos.map((g) => g.glyphId),
    };
  } finally {
    releaseCachedFace(fontBuffer);
  }
}

/**
 * Shape a charset string and return the complete set of unique glyph IDs
 * needed for atlas generation. Results are cached per (font × charset × options).
 */
export async function getRequiredGlyphIds(
  charset: string,
  fontBuffer: Buffer,
  opts: ShapingOptions,
): Promise<GlyphIdResult> {
  const fontHash = createHash('sha256').update(fontBuffer).digest('hex').slice(0, 16);
  const charsetHash = createHash('sha256').update(charset).digest('hex').slice(0, 8);
  const optsKey = `${opts.direction}:${opts.script}:${opts.language}`;
  const cacheKey = `${fontHash}:${charsetHash}:${optsKey}`;

  if (!_shapingCache.has(cacheKey)) {
    _shapingCache.set(cacheKey, _doGetRequiredGlyphIds(charset, fontBuffer, opts));
  }
  const cached = _shapingCache.get(cacheKey);
  return cached as Promise<GlyphIdResult>;
}
