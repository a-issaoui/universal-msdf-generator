# Upgrade Plan: Multilanguage & Arabic Script Support

## 0. Read This First

This document is the definitive implementation plan for adding complex script support (Arabic, Persian, Urdu, Hebrew, Indic, etc.) to `universal-msdf-generator`. It supersedes any earlier notes. Read all sections before writing a single line of code.

---

## 1. The Core Problem: Codepoints vs Glyph IDs

This is the single most important concept. Everything else follows from it.

### 1.1 How the Current System Works (Latin)

```
charset string ("ABC…") → codepoints [65, 66, 67…] → gen.loadGlyphs(codepoints)
```

There is a 1:1 mapping. The character `A` (U+0041) always maps to one glyph via the font's `cmap` table. `msdfgen-wasm` calls `_getGlyphIndex(unicode)` (cmap lookup) then `_loadGlyph(index)`.

### 1.2 Why Arabic Breaks This

A single Arabic codepoint maps to **multiple glyphs** depending on the joining context:

| Character | Codepoint | Isolated | Initial | Medial | Final |
|-----------|-----------|---------|---------|--------|-------|
| ب (Beh) | U+0628 | glyph 45 | glyph 46 | glyph 47 | glyph 48 |
| ل (Lam) | U+0644 | glyph 89 | glyph 90 | glyph 91 | glyph 92 |
| لا (Lam-Alef) | U+0644+U+0627 | — | — | — | glyph 203 (ligature) |

Passing `[0x0628, 0x0644]` to `gen.loadGlyphs()` yields only isolated forms. The three contextual forms and all ligatures — which are different glyph IDs stored in the font's GSUB table — are never loaded.

### 1.3 The Solution

1. Use HarfBuzz to shape the charset in every contextual combination → collect the complete set of required glyph IDs.
2. Load those glyph IDs directly into `msdfgen-wasm` by calling the low-level WASM export `_loadGlyph(glyphId)` directly, bypassing `loadGlyphs()`.

Step 2 requires accessing `gen._module` (a private field of the Msdfgen class). This is intentional. The `msdfgen-wasm` JS wrapper does not expose a `loadGlyphsByIndex()` public method. The WASM binary itself does expose `_loadGlyph(index)` and we call it directly. Pin the `msdfgen-wasm` version and add a smoke test so any upstream API breakage is detected immediately.

**Phase 0 prerequisite (before writing any code):** Run the following isolated Node.js script to confirm `_loadGlyph` is still exposed on `gen._module` in the installed version:

```javascript
// scripts/verify-msdfgen-api.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Msdfgen } from 'msdfgen-wasm';
const require = createRequire(import.meta.url);
const wasmPath = require.resolve('msdfgen-wasm/wasm');
const buf = readFileSync(wasmPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gen = await Msdfgen.create(ab);
console.assert(typeof gen._module._loadGlyph === 'function', '_loadGlyph not found');
console.assert(typeof gen._module._getGlyphIndex === 'function', '_getGlyphIndex not found');
console.log('msdfgen-wasm private API verified OK');
```

Also before writing code, run the following to confirm `harfbuzzjs` works in isolation with a real Arabic font (Noto Sans Arabic is recommended — permissive SIL Open Font License):

```javascript
// scripts/verify-harfbuzz.mjs
import hbjs from 'harfbuzzjs/hbjs.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const wasmPath = require.resolve('harfbuzzjs/hb.wasm');
const wasmBytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const hb = hbjs(instance);

const fontBuf = readFileSync('./test/fixtures/NotoSansArabic-Regular.ttf');
const blob = hb.createBlob(fontBuf);
const face = hb.createFace(blob, 0);
const font = hb.createFont(face);
const upem = face.upem;
font.setScale(upem, upem);
blob.destroy();

const buf = hb.createBuffer();
buf.addText('لا');          // Lam + Alef = should collapse to ONE ligature glyph
buf.setDirection('rtl');
buf.setScript('Arab');
buf.setLanguage('ar');
hb.shape(font, buf);

const infos = buf.getGlyphInfos();
console.assert(infos.length === 1, `Expected 1 ligature glyph, got ${infos.length}`);
console.log(`Lam-Alef ligature glyph ID: ${infos[0].codepoint}`); // .codepoint holds glyph ID after shaping
buf.destroy();
font.destroy();
face.destroy();
console.log('harfbuzzjs verified OK');
```

Both scripts must pass before Phase 1 begins.

---

## 2. New Dependency

### `harfbuzzjs` — optional peer dependency

```bash
npm install harfbuzzjs
```

- **Size:** ~1.2 MB WASM binary (not 300 KB as sometimes cited)
- **API:** `harfbuzzjs` ships a JS wrapper (`hbjs.js`) that exposes `hb.createBuffer()`, `hb.createFont()`, `buf.addText()`, `buf.getGlyphInfos()`, etc. **Do not access the raw WASM exports directly** — use the provided wrapper.
- **Memory model:** All HarfBuzz objects must be explicitly destroyed with `.destroy()`. The WASM heap has no garbage collector.
- **Lazy loading:** Only initialize HarfBuzz when `complexShaping` is triggered. Users who only generate Latin fonts never pay the initialization cost (~80–150ms) and do not need the package installed.
- **Declaration:** Add as `peerDependencies` (optional) in `package.json`.

```json
"peerDependencies": {
  "harfbuzzjs": ">=0.3.6"
},
"peerDependenciesMeta": {
  "harfbuzzjs": { "optional": true }
}
```

---

## 3. Architecture

### 3.1 Components That Require No Changes

| File | Reason |
|------|--------|
| `font-format.ts` | Magic-byte detection is format-level, script-agnostic |
| `font-loader.ts` | TTF/OTF normalization works for all scripts |
| `woff2-service.ts` | Decompression is binary-level |
| `xml-generator.ts` | BMFont XML schema is the same for all scripts |
| `utils.ts` (file I/O) | File saving, metadata, sidecar logic unchanged |
| Identity/cache system | Slug generation and `*-meta.json` logic unchanged |

### 3.2 New Files to Create

```
src/
  script-detector.ts   ← Unicode range analysis: does a charset require shaping?
  shaper.ts            ← HarfBuzz wrapper: initialization, shapeText(), getRequiredGlyphIds()
  glyph-loader.ts      ← Direct glyph-ID loader into msdfgen-wasm (uses _module private API)
  presentation-forms.ts← Fallback: Presentation Forms codepoint expansion (no HarfBuzz needed)
```

### 3.3 Modified Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `complexShaping`, `direction`, `script`, `language` to `GenerateOptions`; extend `CharsetName`; add `shapingEngine`/`glyphIdMap` to `MSDFSuccess.metadata` |
| `src/utils.ts` | Add `arabic`, `persian`, `urdu`, `hebrew` to `COMMON_CHARSETS` and `resolveStringCharset` |
| `src/converter-worker.ts` | Add shaping branch before `gen.loadGlyphs()`; `runConversion` becomes `async` |
| `src/converter.ts` | Pass `complexShaping`/`script`/`direction`/`language` through to `ConvertJobOptions` |
| `src/index.ts` | Auto-detect and set shaping defaults for Arabic/Hebrew charset names |
| `src/fetcher/google-fonts.ts` | Add subset hint to CSS API URL for non-Latin scripts; add verbose log when no latin block found |
| `src/cli.ts` | Add `--complex-shaping`, `--direction`, `--language`, `--script` flags |

---

## 4. Implementation — New Files

### 4.1 `src/script-detector.ts`

```typescript
/**
 * script-detector.ts
 *
 * Analyzes a charset string and determines whether it contains complex-script
 * characters that require HarfBuzz shaping.
 */

const COMPLEX_SCRIPT_RANGES: Array<{
  start: number;
  end: number;
  script: string;
  direction: 'rtl' | 'ltr';
}> = [
  { start: 0x0600, end: 0x06FF, script: 'Arab', direction: 'rtl' }, // Arabic
  { start: 0x0750, end: 0x077F, script: 'Arab', direction: 'rtl' }, // Arabic Supplement
  { start: 0x08A0, end: 0x08FF, script: 'Arab', direction: 'rtl' }, // Arabic Extended-A
  { start: 0xFB50, end: 0xFDFF, script: 'Arab', direction: 'rtl' }, // Arabic Presentation Forms-A
  { start: 0xFE70, end: 0xFEFF, script: 'Arab', direction: 'rtl' }, // Arabic Presentation Forms-B
  { start: 0x0590, end: 0x05FF, script: 'Hebr', direction: 'rtl' }, // Hebrew
  { start: 0xFB1D, end: 0xFB4F, script: 'Hebr', direction: 'rtl' }, // Hebrew Presentation Forms
  { start: 0x0700, end: 0x074F, script: 'Syrc', direction: 'rtl' }, // Syriac
  { start: 0x0900, end: 0x097F, script: 'Deva', direction: 'ltr' }, // Devanagari
  { start: 0x0980, end: 0x09FF, script: 'Beng', direction: 'ltr' }, // Bengali
  { start: 0x0E00, end: 0x0E7F, script: 'Thai', direction: 'ltr' }, // Thai
];

export interface ScriptAnalysis {
  requiresShaping: boolean;
  primaryScript: string | null;
  primaryDirection: 'rtl' | 'ltr';
  scriptCoverage: Map<string, number>; // script → character count
}

export function analyzeCharset(charset: string): ScriptAnalysis {
  const coverage = new Map<string, number>();

  for (const char of charset) {
    const cp = char.codePointAt(0)!;
    for (const range of COMPLEX_SCRIPT_RANGES) {
      if (cp >= range.start && cp <= range.end) {
        coverage.set(range.script, (coverage.get(range.script) ?? 0) + 1);
        break;
      }
    }
  }

  if (coverage.size === 0) {
    return { requiresShaping: false, primaryScript: null, primaryDirection: 'ltr', scriptCoverage: coverage };
  }

  let primaryScript: string | null = null;
  let maxCount = 0;
  for (const [script, count] of coverage) {
    if (count > maxCount) { maxCount = count; primaryScript = script; }
  }

  const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Syrc', 'Thaa', 'Cprt']);
  const primaryDirection = primaryScript && RTL_SCRIPTS.has(primaryScript) ? 'rtl' : 'ltr';

  return { requiresShaping: true, primaryScript, primaryDirection, scriptCoverage: coverage };
}

export function isComplexScriptCodepoint(cp: number): boolean {
  return COMPLEX_SCRIPT_RANGES.some((r) => cp >= r.start && cp <= r.end);
}

export function autoDetectComplexScript(charset: string): boolean {
  return analyzeCharset(charset).requiresShaping;
}
```

### 4.2 `src/shaper.ts`

**Critical implementation notes before reading this code:**

1. `harfbuzzjs` ships a high-level JS wrapper (`hbjs.js`). Use it — do not access raw WASM exports directly.
2. After `hb.shape()`, `GlyphInfo.codepoint` no longer holds the Unicode codepoint. HarfBuzz overwrites it with the resolved **glyph ID**. This is intentional and documented in the HarfBuzz source. The `cluster` field retains the original byte offset into the input string.
3. HarfBuzz positions are in **raw font design units** (scaled to `upem` by `font.setScale(upem, upem)`). Divide by `upem` to get em-relative values. Do **not** divide by 64 — that is FreeType's 26.6 fixed-point format, which `harfbuzzjs` does not use.
4. Use a **dual-joining Arabic character** (ب U+0628) as the context connector when sampling contextual forms, not ZWJ (U+200D). ZWJ does not reliably trigger Arabic GSUB lookups; only real adjacent Arabic characters with the correct Unicode Joining Type (type D = Dual) do.
5. Always destroy HarfBuzz objects (face, font, buffer) with `.destroy()`. The WASM heap has no GC.

```typescript
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
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import hbjs from 'harfbuzzjs/hbjs.js';
import { isComplexScriptCodepoint } from './script-detector.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ShapingOptions {
  direction: 'rtl' | 'ltr';
  script: string;   // ISO 15924 four-letter code, e.g. 'Arab'
  language: string; // BCP 47 tag, e.g. 'ar', 'fa', 'ur'
}

export interface GlyphIdResult {
  /** Unique glyph IDs required for the atlas (includes all contextual forms + ligatures) */
  glyphIds: Set<number>;
  /** Maps glyph ID → source Unicode codepoint (for BMFont metadata) */
  glyphIdToCodepoint: Map<number, number>;
  /** Ligatures: each entry is a single glyph that replaces multiple source codepoints */
  ligatures: Array<{ glyphId: number; sourceCodepoints: number[] }>;
}

// ── HarfBuzz singleton ────────────────────────────────────────────────────────

type HbInstance = ReturnType<typeof hbjs>;
let _hb: HbInstance | null = null;
let _hbInit: Promise<void> | null = null;

export async function getHarfBuzz(): Promise<HbInstance> {
  if (_hb) return _hb;
  if (!_hbInit) {
    _hbInit = (async () => {
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('harfbuzzjs/hb.wasm');
      const wasmBytes = await fs.readFile(wasmPath);
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      _hb = hbjs(instance);
    })();
  }
  await _hbInit;
  return _hb as HbInstance;
}

// ── Per-font face cache ────────────────────────────────────────────────────────
// Loading a HarfBuzz face (parsing GSUB/GPOS tables) takes ~10–30ms per font.
// Cache keyed by SHA-256 of the font buffer (first 16 hex chars).

interface CachedFace {
  face: ReturnType<HbInstance['createFace']>;
  font: ReturnType<HbInstance['createFont']>;
  upem: number;
}

const _faceCache = new Map<string, CachedFace>();

function getCachedFace(hb: HbInstance, fontBuffer: Buffer): CachedFace {
  const key = createHash('sha256').update(fontBuffer).digest('hex').slice(0, 16);
  if (_faceCache.has(key)) return _faceCache.get(key)!;

  const blob = hb.createBlob(fontBuffer);
  const face = hb.createFace(blob, 0);
  const font = hb.createFont(face);
  const upem = face.upem;
  font.setScale(upem, upem);
  blob.destroy(); // Blob is copied into face; safe to free

  const cached = { face, font, upem };
  _faceCache.set(key, cached);
  return cached;
}

/** Release all cached HarfBuzz faces/fonts. Call from dispose() in long-running servers. */
export function clearShaperCache(): void {
  for (const { face, font } of _faceCache.values()) {
    font.destroy();
    face.destroy();
  }
  _faceCache.clear();
  _shapingCache.clear();
}

// ── Shaping result cache ──────────────────────────────────────────────────────
// Caches the GlyphIdResult per (font × charset × options) to avoid re-shaping
// the same charset in batch mode.

const _shapingCache = new Map<string, Promise<GlyphIdResult>>();

// ── Context generation ────────────────────────────────────────────────────────
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
    char,                                  // Isolated (no neighbours → isol form)
    `${char}${CONNECTOR}`,                 // Initial (joins right → init form)
    `${CONNECTOR}${char}${CONNECTOR}`,     // Medial (joins both sides → medi form)
    `${CONNECTOR}${char}`,                 // Final (joins left → fina form)
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

function shapeOnce(
  hb: HbInstance,
  font: ReturnType<HbInstance['createFont']>,
  upem: number,
  text: string,
  opts: ShapingOptions,
): Array<{ glyphId: number; cluster: number }> {
  const buf = hb.createBuffer();
  try {
    buf.addText(text);
    buf.setDirection(opts.direction);
    buf.setScript(opts.script);
    buf.setLanguage(opts.language);
    buf.guessSegmentProperties();

    // Required Arabic OpenType features.
    // HarfBuzz enables ccmp/isol/init/medi/fina/rlig automatically for Arab script;
    // these are listed explicitly for documentation purposes.
    hb.shape(font, buf, [
      { tag: 'ccmp', value: 1 }, // Character composition/decomposition (must be first)
      { tag: 'isol', value: 1 },
      { tag: 'init', value: 1 },
      { tag: 'medi', value: 1 },
      { tag: 'fina', value: 1 },
      { tag: 'rlig', value: 1 }, // Required ligatures (Lam-Alef — cannot be disabled)
      { tag: 'calt', value: 1 },
      { tag: 'liga', value: 1 },
      { tag: 'mark', value: 1 }, // Mark positioning (Tashkil/diacritics)
      { tag: 'mkmk', value: 1 }, // Mark-to-mark
      { tag: 'kern', value: 1 },
    ]);

    // After hb.shape(), GlyphInfo.codepoint holds the GLYPH ID, not the Unicode codepoint.
    // This is intentional HarfBuzz naming — see HarfBuzz docs for hb_glyph_info_t.
    return buf.getGlyphInfos().map((info) => ({
      glyphId: info.codepoint, // Glyph ID (renamed by HarfBuzz after shaping)
      cluster: info.cluster,
    }));
  } finally {
    buf.destroy(); // Always destroy — WASM heap has no GC
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function _doGetRequiredGlyphIds(
  charset: string,
  fontBuffer: Buffer,
  opts: ShapingOptions,
): Promise<GlyphIdResult> {
  const hb = await getHarfBuzz();
  const { font, upem } = getCachedFace(hb, fontBuffer);

  const glyphIds = new Set<number>();
  const glyphIdToCodepoint = new Map<number, number>();
  const ligatures: GlyphIdResult['ligatures'] = [];
  const seenLigaturePairs = new Set<string>();

  for (const char of new Set(charset)) {
    const cp = char.codePointAt(0)!;
    const isComplex = isComplexScriptCodepoint(cp);

    const samples = isComplex ? arabicContextSamples(char) : [char];

    for (const sample of samples) {
      const shaped = shapeOnce(hb, font, upem, sample, opts);

      for (const { glyphId, cluster } of shaped) {
        if (glyphId === 0) continue; // .notdef — skip
        // For contextual samples, only record glyphs at cluster=0 (the target char)
        // to exclude the connector glyph (ب) from the result set.
        const isConnectorGlyph = sample !== char && cluster !== 0;
        if (isConnectorGlyph) continue;
        if (!glyphIds.has(glyphId)) {
          glyphIds.add(glyphId);
          if (!glyphIdToCodepoint.has(glyphId)) {
            glyphIdToCodepoint.set(glyphId, cp);
          }
        }
      }
    }
  }

  // Shape known ligature pairs to ensure ligature glyphs are captured
  for (const [a, b] of LIGATURE_PAIRS) {
    if (!charset.includes(a) || !charset.includes(b)) continue;
    const pairKey = `${a}${b}`;
    if (seenLigaturePairs.has(pairKey)) continue;
    seenLigaturePairs.add(pairKey);

    const shaped = shapeOnce(hb, font, upem, `${a}${b}`, opts);
    // A ligature produces fewer glyphs than input characters
    if (shaped.length < 2) {
      for (const { glyphId } of shaped) {
        if (glyphId === 0) continue;
        if (!glyphIds.has(glyphId)) {
          glyphIds.add(glyphId);
          ligatures.push({
            glyphId,
            sourceCodepoints: [a.codePointAt(0)!, b.codePointAt(0)!],
          });
        }
      }
    }
  }

  return { glyphIds, glyphIdToCodepoint, ligatures };
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
  return _shapingCache.get(cacheKey)!;
}
```

### 4.3 `src/glyph-loader.ts`

Bridges HarfBuzz glyph IDs to `msdfgen-wasm`. Accesses private fields on `Msdfgen`.

```typescript
/**
 * glyph-loader.ts
 *
 * Loads glyphs into a Msdfgen instance by glyph ID (not Unicode codepoint).
 * Bypasses gen.loadGlyphs() and calls gen._module._loadGlyph() directly.
 *
 * PRIVATE API USE:
 *   - gen._module  — the Emscripten WASM module
 *   - gen._glyphs  — internal glyph array
 *   - gen._glyphMap — internal unicode→glyph map
 *   - gen._tmp     — WASM scratch buffer pointer
 *
 * These fields are stable across msdfgen-wasm versions released to date.
 * Pin msdfgen-wasm in package.json and run scripts/verify-msdfgen-api.mjs
 * in CI to detect any upstream breakage before it reaches production.
 *
 * UNICODE ASSIGNMENT STRATEGY:
 * Each glyph stored in the BMFont layout requires an integer `id` field.
 * - Glyphs with a known source Unicode: use the Unicode value (passed via glyphIdToCodepoint).
 * - Glyphs with no Unicode (contextual forms, ligatures): assign a Private Use Area (PUA)
 *   codepoint starting at U+E000. The mapping is returned so callers can store it
 *   in the generation metadata.
 */

import type { Msdfgen } from 'msdfgen-wasm';

const PUA_START = 0xe000; // Unicode Private Use Area start
const PUA_END   = 0xf8ff; // Unicode Private Use Area end (6399 slots)

export interface GlyphLoadResult {
  glyphIdToUnicode: Map<number, number>; // glyph ID → BMFont `id` value
  loaded: number;
  skipped: number;
}

// biome-ignore lint/suspicious/noExplicitAny: msdfgen-wasm internals are untyped
type WasmModule = any;

/**
 * Load shaped glyphs into the Msdfgen WASM instance.
 *
 * Call AFTER gen.loadFont() and INSTEAD OF gen.loadGlyphs().
 * After this call, gen.packGlyphs() and gen.createAtlasImage() work normally.
 */
export function loadGlyphsByIds(
  gen: Msdfgen,
  glyphIds: Set<number>,
  glyphIdToCodepoint: Map<number, number>,
  options: { preprocess?: boolean } = {},
): GlyphLoadResult {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private fields
  const g = gen as any;
  const module: WasmModule = g._module;
  const tmp: number = g._tmp;
  const preprocess = options.preprocess ?? true;

  // Reset internal glyph state (mirrors gen.unloadGlyphs())
  if (g._glyphs) {
    for (const glyph of g._glyphs) module._destroyGlyph(glyph._ptr);
  }
  g._glyphs = [];
  g._glyphMap = new Map<number, unknown>();

  const floatView: Float64Array = module.HEAPF64.subarray((tmp + 8) / 8);
  const heapu32: Uint32Array   = module.HEAPU32.subarray(tmp / 4);

  const glyphIdToUnicode = new Map<number, number>();
  let puaIndex = 0;
  let loaded = 0;
  let skipped = 0;

  for (const glyphId of glyphIds) {
    if (glyphId === 0) { skipped++; continue; }

    const errorCode: number = module._loadGlyph(glyphId, tmp, preprocess ? 1 : 0);
    if (errorCode !== 0) { skipped++; continue; }

    // Assign a stable unicode value for the BMFont `id` field
    let unicode = glyphIdToCodepoint.get(glyphId);
    if (unicode === undefined) {
      if (PUA_START + puaIndex > PUA_END) { skipped++; continue; } // PUA exhausted
      unicode = PUA_START + puaIndex++;
    }

    const glyph = {
      index:   glyphId,
      unicode,
      advance: floatView[0],
      left:    floatView[1],
      bottom:  floatView[2],
      right:   floatView[3],
      top:     floatView[4],
      kerning: [] as unknown[],
      _ptr:    heapu32[0],
    };

    g._glyphs.push(glyph);
    g._glyphMap.set(unicode, glyph);
    glyphIdToUnicode.set(glyphId, unicode);
    loaded++;
  }

  // Load kerning (indexed by glyph index, not unicode — no changes needed)
  try { g.loadKerningData(); } catch { /* Non-fatal: some Arabic fonts have no kern */ }

  return { glyphIdToUnicode, loaded, skipped };
}
```

### 4.4 `src/presentation-forms.ts`

Fallback for when HarfBuzz is unavailable or the font lacks a GSUB table. Expands base Arabic codepoints to their Presentation Forms (U+FB50–U+FEFF) which are accessible via `cmap` in many legacy Arabic fonts.

**Limitations (document clearly in release notes):**
- Covers only the 28 core Arabic letters — no extended Arabic or Indic
- No language-specific alternates (Persian Yeh differs from Arabic Yeh)
- No diacritic anchor positioning
- Does not work for modern OpenType-only fonts (Noto, Vazirmatn, etc.) that omit Presentation Forms from their `cmap`

```typescript
/**
 * presentation-forms.ts
 *
 * Fallback strategy: expand base Arabic codepoints to Presentation Forms.
 * Only useful for legacy Arabic fonts with Presentation Forms in their cmap.
 * Modern fonts (Noto, Vazirmatn, Amiri) require HarfBuzz shaping instead.
 */

export const ARABIC_PRESENTATION_MAP = new Map<number, {
  isolated?: number; initial?: number; medial?: number; final?: number;
}>([
  [0x0628, { isolated: 0xFE8F, initial: 0xFE91, medial: 0xFE92, final: 0xFE90 }], // ب
  [0x062A, { isolated: 0xFE95, initial: 0xFE97, medial: 0xFE98, final: 0xFE96 }], // ت
  [0x062B, { isolated: 0xFE99, initial: 0xFE9B, medial: 0xFE9C, final: 0xFE9A }], // ث
  [0x062C, { isolated: 0xFE9D, initial: 0xFE9F, medial: 0xFEA0, final: 0xFE9E }], // ج
  [0x062D, { isolated: 0xFEA1, initial: 0xFEA3, medial: 0xFEA4, final: 0xFEA2 }], // ح
  [0x062E, { isolated: 0xFEA5, initial: 0xFEA7, medial: 0xFEA8, final: 0xFEA6 }], // خ
  [0x062F, { isolated: 0xFEA9, final: 0xFEAA }],                                  // د (right-joining: no init/medi)
  [0x0630, { isolated: 0xFEAB, final: 0xFEAC }],                                  // ذ
  [0x0631, { isolated: 0xFEAD, final: 0xFEAE }],                                  // ر
  [0x0632, { isolated: 0xFEAF, final: 0xFEB0 }],                                  // ز
  [0x0633, { isolated: 0xFEB1, initial: 0xFEB3, medial: 0xFEB4, final: 0xFEB2 }], // س
  [0x0634, { isolated: 0xFEB5, initial: 0xFEB7, medial: 0xFEB8, final: 0xFEB6 }], // ش
  [0x0635, { isolated: 0xFEB9, initial: 0xFEBB, medial: 0xFEBC, final: 0xFEBA }], // ص
  [0x0636, { isolated: 0xFEBD, initial: 0xFEBF, medial: 0xFEC0, final: 0xFEBE }], // ض
  [0x0637, { isolated: 0xFEC1, initial: 0xFEC3, medial: 0xFEC4, final: 0xFEC2 }], // ط
  [0x0638, { isolated: 0xFEC5, initial: 0xFEC7, medial: 0xFEC8, final: 0xFEC6 }], // ظ
  [0x0639, { isolated: 0xFEC9, initial: 0xFECB, medial: 0xFECC, final: 0xFECA }], // ع
  [0x063A, { isolated: 0xFECD, initial: 0xFECF, medial: 0xFED0, final: 0xFECE }], // غ
  [0x0641, { isolated: 0xFED1, initial: 0xFED3, medial: 0xFED4, final: 0xFED2 }], // ف
  [0x0642, { isolated: 0xFED5, initial: 0xFED7, medial: 0xFED8, final: 0xFED6 }], // ق
  [0x0643, { isolated: 0xFED9, initial: 0xFEDB, medial: 0xFEDC, final: 0xFEDA }], // ك
  [0x0644, { isolated: 0xFEDD, initial: 0xFEDF, medial: 0xFEE0, final: 0xFEDE }], // ل
  [0x0645, { isolated: 0xFEE1, initial: 0xFEE3, medial: 0xFEE4, final: 0xFEE2 }], // م
  [0x0646, { isolated: 0xFEE5, initial: 0xFEE7, medial: 0xFEE8, final: 0xFEE6 }], // ن
  [0x0647, { isolated: 0xFEE9, initial: 0xFEEB, medial: 0xFEEC, final: 0xFEEA }], // ه
  [0x0648, { isolated: 0xFEED, final: 0xFEEE }],                                  // و (right-joining)
  [0x064A, { isolated: 0xFEF1, initial: 0xFEF3, medial: 0xFEF4, final: 0xFEF2 }], // ي
]);

// Lam-Alef mandatory ligatures (most common first)
export const LAM_ALEF_PRESENTATION: number[] = [
  0xFEFB, 0xFEFC, // Lam + Alef (most common: isolated, final)
  0xFEF5, 0xFEF6, // Lam + Alef with Madda Above
  0xFEF7, 0xFEF8, // Lam + Alef with Hamza Above
  0xFEF9, 0xFEFA, // Lam + Alef with Hamza Below
];

export function resolvePresentationForms(charset: string): number[] {
  const result = new Set<number>();

  for (const char of charset) {
    const cp = char.codePointAt(0)!;
    const forms = ARABIC_PRESENTATION_MAP.get(cp);
    if (forms) {
      result.add(cp); // base (isolated via cmap)
      for (const v of Object.values(forms)) if (v !== undefined) result.add(v);
    } else {
      result.add(cp);
    }
  }

  if (charset.includes('\u0644')) { // Lam present
    for (const lc of LAM_ALEF_PRESENTATION) result.add(lc);
  }

  return Array.from(result);
}
```

---

## 5. Implementation — Modified Files

### 5.1 `src/types.ts`

Add to `GenerateOptions` after `streamAtlases`:

```typescript
/**
 * Enable HarfBuzz text shaping for complex scripts (Arabic, Hebrew, Indic, etc.).
 * Automatically set to true when charset is 'arabic', 'persian', 'urdu', or 'hebrew'.
 * Requires `harfbuzzjs` to be installed as a peer dependency.
 * @default false
 */
complexShaping?: boolean;

/**
 * ISO 15924 four-letter script tag (e.g. 'Arab', 'Hebr', 'Deva', 'Thai').
 * Required for HarfBuzz shaping when auto-detection is insufficient.
 */
script?: string;

/**
 * Text direction. Auto-detected from script when not set.
 * @default 'rtl' for Arab/Hebr/Syrc scripts, 'ltr' otherwise
 */
direction?: 'ltr' | 'rtl';

/**
 * BCP 47 language tag for language-specific OpenType features.
 * Persian ('fa') and Urdu ('ur') require different shaping rules from Arabic ('ar')
 * despite sharing the Arabic script.
 */
language?: string;
```

Update `CharsetName`:

```typescript
export type CharsetName =
  | 'ascii' | 'alphanumeric' | 'latin' | 'cyrillic' | 'custom'
  | 'arabic' | 'persian' | 'urdu' | 'hebrew';
```

Add to `MSDFSuccess.metadata`:

```typescript
/** Shaping engine used. 'none' for Latin/CJK, 'harfbuzz' for Arabic/Hebrew, 'presentation-forms' for fallback. */
shapingEngine?: 'harfbuzz' | 'presentation-forms' | 'none';
/** Maps glyph IDs to source Unicode codepoints (only present when shapingEngine is 'harfbuzz') */
glyphIdMap?: Record<number, number>;
```

### 5.2 `src/utils.ts`

Add to `COMMON_CHARSETS`. Comments explain exactly what's included and why:

```typescript
arabic: () => {
  // 36 Arabic letters (including common variants like Alef with Hamza)
  const letters =
    '\u0621\u0622\u0623\u0624\u0625\u0626\u0627\u0628\u0629\u062A' +
    '\u062B\u062C\u062D\u062E\u062F\u0630\u0631\u0632\u0633\u0634' +
    '\u0635\u0636\u0637\u0638\u0639\u063A\u0641\u0642\u0643\u0644' +
    '\u0645\u0646\u0647\u0648\u0649\u064A';
  // Arabic-Indic numerals (U+0660–U+0669)
  const numerals = '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669';
  // Tashkil diacritics (Fathah, Dammah, Kasrah, Sukun, Shaddah + Tanwin forms)
  const tashkil = '\u064B\u064C\u064D\u064E\u064F\u0650\u0651\u0652\u0653\u0654\u0655';
  // Tatweel/Kashida elongation mark (repeated by renderer for justification)
  const tatweel = '\u0640';
  // Common punctuation
  const punctuation = '\u060C\u061B\u061F\u0021\u002E\u003A\u0028\u0029';
  return letters + numerals + tashkil + tatweel + punctuation;
},

// Persian: Arabic + 4 Farsi-specific letters + Eastern Arabic numerals
persian: () =>
  COMMON_CHARSETS.arabic() +
  '\u067E\u0686\u0698\u06AF\u06CC' +                                // پ چ ژ گ ی (Persian Yeh)
  '\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9',  // ۰–۹

// Urdu: Persian + Urdu-specific letters
urdu: () =>
  COMMON_CHARSETS.persian() +
  '\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06C2\u06D2\u06D3',

// Hebrew: 27 consonants + 5 final forms + Niqqud vowel points
hebrew: () => {
  const consonants = Array.from({ length: 27 }, (_, i) =>
    String.fromCodePoint(0x05d0 + i)).join('');
  const niqqud = '\u05B0\u05B1\u05B2\u05B3\u05B4\u05B5\u05B6\u05B7\u05B8\u05B9\u05BB\u05BC\u05BD\u05BF\u05C1\u05C2';
  return consonants + niqqud;
},
```

Update `resolveStringCharset` to add:

```typescript
if (c === 'arabic') return COMMON_CHARSETS.arabic();
if (c === 'persian') return COMMON_CHARSETS.persian();
if (c === 'urdu') return COMMON_CHARSETS.urdu();
if (c === 'hebrew') return COMMON_CHARSETS.hebrew();
```

### 5.3 `src/converter-worker.ts`

Add to `ConvertJobOptions`:

```typescript
complexShaping?: boolean;
script?: string;
direction?: 'ltr' | 'rtl';
language?: string;
```

Make `runConversion` async. Replace the codepoint block:

```typescript
// ── NEW: shaping or plain codepoint path ───────────────────────────────────
const charString = resolveCharset(
  charset as string | (string | number)[] | Set<string | number> | undefined,
);

const useShaping =
  options.complexShaping === true ||
  (options.complexShaping !== false && autoDetectComplexScript(charString));

let shapingEngine: 'harfbuzz' | 'presentation-forms' | 'none' = 'none';
let glyphIdMap: Record<number, number> | undefined;

if (useShaping) {
  const shapingOptions: ShapingOptions = {
    direction: options.direction ?? (analysis.primaryDirection ?? 'rtl'),
    script:    options.script   ?? (analysis.primaryScript   ?? 'Arab'),
    language:  options.language ?? 'ar',
  };
  // analysis = analyzeCharset(charString) — compute once
  const analysis = analyzeCharset(charString);
  shapingOptions.direction = options.direction ?? analysis.primaryDirection ?? 'rtl';
  shapingOptions.script    = options.script    ?? analysis.primaryScript    ?? 'Arab';

  try {
    const { glyphIds, glyphIdToCodepoint } = await getRequiredGlyphIds(
      charString, fontBuffer, shapingOptions,
    );
    if (glyphIds.size > 0) {
      const loadResult = loadGlyphsByIds(gen, glyphIds, glyphIdToCodepoint, { preprocess: fixOverlaps });
      glyphIdMap = Object.fromEntries(loadResult.glyphIdToUnicode);
      shapingEngine = 'harfbuzz';
    }
  } catch (err) {
    // HarfBuzz failed (harfbuzzjs not installed, or font has no GSUB) — fall back
    const codepoints = resolvePresentationForms(charString);
    if (codepoints.length > 0) gen.loadGlyphs(codepoints, { preprocess: fixOverlaps });
    shapingEngine = 'presentation-forms';
  }
} else {
  // ── EXISTING PATH — unchanged ────────────────────────────────────────────
  const codepoints = Array.from(new Set(charString), (c) => c.codePointAt(0))
    .filter((cp): cp is number => cp !== undefined);
  if (codepoints.length > 0) gen.loadGlyphs(codepoints, { preprocess: fixOverlaps });
}
```

Pass `shapingEngine` and `glyphIdMap` through to the returned layout/metadata.

Also update the worker message handler to `await runConversion(...)` since it is now async.

**Important — xAdvance:** Do NOT negate `xadvance` for RTL scripts. The BMFont `xadvance` field is always a positive cursor advance distance. Direction (LTR vs RTL) is a renderer responsibility, not an atlas responsibility. The existing `buildLayout` code is correct as-is.

### 5.4 `src/index.ts`

In `executeGen()`, before calling `converter.convert()`, auto-set shaping defaults for known charset names:

```typescript
const CHARSET_SHAPING_DEFAULTS: Record<string, { script: string; language: string; direction: 'rtl' | 'ltr' }> = {
  arabic:  { script: 'Arab', language: 'ar', direction: 'rtl' },
  persian: { script: 'Arab', language: 'fa', direction: 'rtl' },
  urdu:    { script: 'Arab', language: 'ur', direction: 'rtl' },
  hebrew:  { script: 'Hebr', language: 'he', direction: 'rtl' },
};

const charsetKey = typeof options.charset === 'string' ? options.charset : null;
const shapingDefaults = charsetKey ? CHARSET_SHAPING_DEFAULTS[charsetKey] : null;

if (shapingDefaults) {
  options = {
    complexShaping: true,
    direction:      shapingDefaults.direction,
    script:         shapingDefaults.script,
    language:       shapingDefaults.language,
    ...options, // Caller-supplied values override defaults
  };
}
```

### 5.5 `src/fetcher/google-fonts.ts`

In `fetchGoogleFont()` / `extractLatinFontUrl()`:

1. Add a `subset` hint to the CSS v2 URL for non-Latin scripts:

```typescript
const LANGUAGE_TO_SUBSET: Record<string, string> = {
  ar: 'arabic', fa: 'arabic', ur: 'arabic',
  he: 'hebrew',
  th: 'thai',
  hi: 'devanagari', bn: 'bengali',
};

// Append subset query parameter when a known language is specified:
const subsetParam = options.language
  ? `&subset=${LANGUAGE_TO_SUBSET[options.language] ?? 'latin'}`
  : '';
const cssUrl = `https://fonts.googleapis.com/css2?family=...${subsetParam}&display=swap`;
```

2. When no `latin` unicode-range block is found in the CSS response, log (don't throw):

```typescript
if (!latinBlock && this.options.verbose) {
  console.log('[FontFetcher] No latin unicode-range block found — using last available block (expected for Arabic/Hebrew fonts).');
}
return latinBlock?.url ?? candidates[candidates.length - 1].url;
```

### 5.6 `src/cli.ts`

Add flag handlers:

```typescript
'--complex-shaping':    (_, i, opts) => { opts.complexShaping = true;  return i; },
'--no-complex-shaping': (_, i, opts) => { opts.complexShaping = false; return i; },

'--direction': (args, i, opts) => {
  const val = args[i + 1];
  if (val !== 'ltr' && val !== 'rtl') throw new Error(`--direction must be 'ltr' or 'rtl' (got "${val}")`);
  opts.direction = val;
  return i + 1;
},

'--language': (args, i, opts) => {
  if (!/^[a-z]{2,3}(-[a-zA-Z]{2,4})*$/.test(args[i + 1]))
    throw new Error(`--language must be a BCP 47 tag like 'ar', 'fa', 'ur' (got "${args[i + 1]}")`);
  opts.language = args[i + 1];
  return i + 1;
},

'--script': (args, i, opts) => {
  if (!/^[A-Z][a-z]{3}$/.test(args[i + 1]))
    throw new Error(`--script must be ISO 15924 like 'Arab', 'Hebr', 'Latn' (got "${args[i + 1]}")`);
  opts.script = args[i + 1];
  return i + 1;
},
```

Auto-enable `complexShaping` when `--charset arabic/persian/urdu/hebrew` is passed via the existing `--charset` handler.

Add to `showHelp()`:

```
--charset, -c          Preset: ascii, alphanumeric, latin, cyrillic,
                       arabic, persian, urdu, hebrew (default: latin)
--direction            Text direction: ltr | rtl (auto-detected from charset)
--language             BCP 47 language tag: ar, fa, ur, he, hi, ...
--script               ISO 15924 script code: Arab, Hebr, Deva, Thai, ...
--complex-shaping      Enable HarfBuzz shaping (auto for arabic/persian/urdu/hebrew)
--no-complex-shaping   Disable shaping (fastest but incorrect for Arabic)
```

Example usage:

```bash
npx universal-msdf "Noto Sans Arabic" --charset arabic --out ./assets
npx universal-msdf "Vazirmatn" --charset persian --language fa --out ./assets
npx universal-msdf "Noto Sans Hebrew" --charset hebrew --language he --out ./assets
npx universal-msdf "./fonts/MyFont.ttf" --charset "بتثجحخد" --complex-shaping --direction rtl --language ar
```

---

## 6. Test Coverage

### 6.1 `test/script-detector.test.ts`

```typescript
it('detects Arabic as RTL complex script')
it('detects Hebrew as RTL complex script')
it('returns non-complex for Latin-only charset')
it('returns the dominant script for mixed Arabic+Latin charset')
it('isComplexScriptCodepoint returns false for U+0041 (A) and true for U+0628 (ب)')
```

### 6.2 `test/presentation-forms.test.ts`

```typescript
it('expands ب (Beh U+0628) to all four presentation form codepoints')
it('adds Lam-Alef ligatures when ل is present in charset')
it('preserves non-Arabic codepoints unchanged')
it('right-joining letters (ر, ز, د) only get isolated+final forms (no init/medi)')
```

### 6.3 `test/shaper.test.ts`

These require a real Arabic font in `test/fixtures/`. Acquire Noto Sans Arabic TTF under the SIL Open Font License.

```typescript
it('getRequiredGlyphIds returns more glyph IDs than input codepoints for Arabic')
it('captures the Lam-Alef mandatory ligature as a single glyph')
it('deduplicates glyph IDs across contextual samples')
it('Persian language tag produces different Yeh glyph from Arabic language tag')
it('non-complex characters (Latin) produce exactly one glyph each')
it('glyph ID 0 (.notdef) is excluded from results')
it('clearShaperCache() empties the face and shaping caches')
```

### 6.4 `test/glyph-loader.test.ts`

```typescript
it('loads glyphs into gen._glyphs after loadFont()')
it('assigns PUA codepoints to contextual form glyphs without a Unicode codepoint')
it('assigns source unicode to non-shaped glyphs')
it('skips glyph ID 0')
it('gen.packGlyphs() succeeds after loadGlyphsByIds()')
```

### 6.5 `test/converter.test.ts` additions

```typescript
describe('Arabic shaping path', () => {
  it('calls getRequiredGlyphIds when complexShaping is true')
  it('calls loadGlyphsByIds instead of gen.loadGlyphs for complex charset')
  it('Latin charset with no shaping option is unaffected (gen.loadGlyphs called normally)')
  it('falls back to presentation-forms when harfbuzzjs throws')
  it('auto-detects complex script from charset content when complexShaping is unset')
})
```

### 6.6 Font fixtures for tests

Download and commit to `test/fixtures/` (all SIL Open Font License):
- `NotoSansArabic-Regular.ttf` — full GSUB Arabic support, recommended reference
- `NotoSansHebrew-Regular.ttf` — Hebrew

Do NOT commit fonts to the main repo beyond the `test/fixtures/` directory.

---

## 7. Atlas Size Guidance

Arabic glyph count estimate (more precise than the 4× figure often cited):

| Category | Count |
|----------|-------|
| 28 dual-joining letters × ~3 forms avg | ~84 |
| Right-joining letters (ر, ز, د, و, etc.) × 2 forms | ~16 |
| Common ligatures (Lam-Alef variants) | ~8 |
| Tashkil diacritics (usually zero-advance, small) | ~11 |
| Arabic-Indic numerals | 10 |
| Punctuation | ~8 |
| **Total (Arabic full)** | **~137–145 glyphs** |

This is roughly **1.5× Latin**, not 4×. The 4× figure is only valid if you assume all 28 letters × 4 forms = 112 and ignore that right-joining letters have only 2 forms.

Recommended minimum atlas sizes:

| Charset | fontSize 48 | fontSize 64 |
|---------|------------|------------|
| arabic (no Tashkil) | 1024×1024 | 2048×1024 |
| arabic (with Tashkil) | 2048×1024 | 2048×2048 |
| persian / urdu | 2048×2048 | 4096×2048 |
| hebrew | 512×512 | 1024×512 |

No changes needed to the existing `packGlyphs` configuration or multi-page naming — they handle this automatically.

---

## 8. Phased Implementation Checklist

### Phase 0 — Prerequisites (do this before touching any source file)

- [ ] Run `scripts/verify-msdfgen-api.mjs` — confirm `_loadGlyph` is exposed
- [ ] Run `scripts/verify-harfbuzz.mjs` with Noto Sans Arabic — confirm Lam-Alef collapses to 1 glyph
- [ ] Confirm `harfbuzzjs` version: `npm info harfbuzzjs version` (minimum 0.3.6)
- [ ] Acquire test font fixtures: NotoSansArabic-Regular.ttf, NotoSansHebrew-Regular.ttf

### Phase 1 — Charsets and detection (no HarfBuzz yet)

- [ ] `src/script-detector.ts` + `test/script-detector.test.ts`
- [ ] `src/presentation-forms.ts` + `test/presentation-forms.test.ts`
- [ ] New charset presets in `src/utils.ts` (arabic, persian, urdu, hebrew)
- [ ] `CharsetName` type extension in `src/types.ts`
- [ ] 100% coverage maintained

### Phase 2 — Shaping engine

- [ ] Install `harfbuzzjs`, add to `peerDependencies` as optional
- [ ] `src/shaper.ts` + `test/shaper.test.ts`
- [ ] Validate: Lam-Alef returns 1 glyph ID (the critical integration test)
- [ ] Validate: Persian `language: 'fa'` produces different Yeh form than `language: 'ar'`

### Phase 3 — Glyph loader and converter integration

- [ ] `src/glyph-loader.ts` + `test/glyph-loader.test.ts`
- [ ] `runConversion` in `converter-worker.ts` made async + shaping branch added
- [ ] `GenerateOptions` extended (complexShaping, script, direction, language)
- [ ] `index.ts` auto-detection defaults
- [ ] Full existing test suite must pass with zero regressions

### Phase 4 — Fetcher, CLI, and examples

- [ ] `src/fetcher/google-fonts.ts` — subset hint + verbose log
- [ ] `src/cli.ts` — new flags with validation
- [ ] `examples/arabic.js` end-to-end demo with Noto Sans Arabic

### Phase 5 — QA and performance

- [ ] Integration tests with 3+ Arabic fonts from Google Fonts
- [ ] Memory profile: confirm no HarfBuzz heap leak across 100 sequential calls
- [ ] Benchmark: shaping overhead vs rasterization overhead (expected: shaping < 5ms, rasterization > 100ms)
- [ ] Verify `--format both` (JSON + FNT) outputs valid BMFont for Arabic
- [ ] Verify re-use/cache system with Arabic identity slugs

### Phase 6 — Documentation and release

- [ ] Update README: charset presets table, Arabic CLI examples, renderer guidance
- [ ] CHANGELOG entry (see below)
- [ ] Version bump to **2.0.0**

---

## 9. Version and Changelog

This is a **major** version bump (`1.10.0` → `2.0.0`) because:
- New optional peer dependency (`harfbuzzjs`, +1.2MB package size) — users must be aware
- Behaviour change: `charset: 'arabic'` now auto-enables shaping (was previously unsupported)
- `runConversion` signature changes from sync to async

```markdown
## [2.0.0] - YYYY-MM-DD

### Added
- **Arabic, Persian, Urdu, Hebrew charset presets** — pass `charset: 'arabic'`,
  `'persian'`, `'urdu'`, or `'hebrew'` to `GenerateOptions`.
- **Complex script shaping via HarfBuzz** (`complexShaping: true`): all contextual
  glyph forms (init/medi/fina/isol), mandatory ligatures (Lam-Alef), and GSUB
  substitutions are resolved before atlas generation. Requires optional peer
  dependency `harfbuzzjs`.
- **Auto-detection**: HarfBuzz shaping is automatically enabled when a charset
  containing Arabic/Hebrew/Indic codepoints is detected, with no configuration needed.
- **`script`, `direction`, `language` options** for explicit shaping control.
- **Presentation Forms fallback** (`shapingEngine: 'presentation-forms'`): if
  `harfbuzzjs` is not installed or the font lacks GSUB, the generator falls back
  to Unicode Presentation Forms where available.
- CLI flags: `--complex-shaping`, `--no-complex-shaping`, `--direction`, `--language`, `--script`.

### Changed
- `runConversion` in `converter-worker.ts` is now `async` (no public API impact).

### Breaking
- New optional peer dependency `harfbuzzjs` (>=0.3.6) required for Arabic/Hebrew shaping.
  Install with: `npm install harfbuzzjs`
  If not installed, Arabic charsets fall back to Presentation Forms with a console warning.
```

---

## 10. Known Limitations (Cannot Be Fixed)

Document these explicitly in the README.

**Kashida (Tatweel) justification.** Arabic text justification stretches letters by repeating the Kashida glyph (U+0640). A static atlas cannot encode an infinitely-tileable glyph. Include U+0640 in the charset (it is in the `arabic` preset). The renderer is responsible for tiling it.

**Tashkil anchor positioning.** Diacritics (Fathah, Dammah, etc.) in high-quality Arabic use GPOS anchor points — a per-letter coordinate for each diacritic attachment. The BMFont format stores only a fixed `xoffset`/`yoffset`. Diacritic positioning in MSDF atlases is therefore approximate. For most UI text this is adequate; for Quranic or liturgical text it is not.

**Nastaliq (Urdu calligraphic) layout.** Urdu Nastaliq fonts have a diagonal baseline — letters descend as they connect rightward. The BMFont model assumes a horizontal baseline. Atlases for Nastaliq fonts are valid, but the renderer must implement the diagonal baseline algorithm. Standard PixiJS `BitmapText` does not support this.

**Ligatures beyond Lam-Alef.** Fonts for Quranic text may contain 3–5 character ligatures. The shaper covers standard ligature pairs. Fonts with unusual ligatures may require a future `textSamples` option to pass representative text directly to the shaper.

**Color fonts (COLR/CPAL).** MSDF is monochrome. Color layers are silently ignored and only the base outline is rasterized.

**CJK note (not a limitation).** CJK does not require HarfBuzz shaping (no contextual forms). The existing `gen.loadGlyphs(codepoints)` path works correctly for CJK. The main CJK concern is atlas size (20,000+ glyphs) which is handled by `streamAtlases: true`.
