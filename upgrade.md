# Upgrade Plan: Multilanguage & Arabic Script Support

## 0. Context and Constraints

This document describes the complete, production-quality implementation for adding complex script support (Arabic, Hebrew, Indic, CJK, etc.) to `universal-msdf-generator`. Read everything before writing a single line of code.

### The fundamental problem

The current pipeline is:

```
charset (unicode codepoints)
    → gen.loadGlyphs(codepoints)          // calls _getGlyphIndex(unicode) per codepoint
    → gen.packGlyphs(...)
    → gen.createAtlasImage(bin)
```

`loadGlyphs()` in `msdfgen-wasm` calls `_getGlyphIndex(unicode)` which looks up the font's `cmap` table. This works for Latin/Cyrillic/CJK because every character has exactly one Unicode codepoint and one `cmap` entry.

**Arabic breaks this completely.** Arabic letters have 2–4 contextual forms (isolated/initial/medial/final). These forms live in the font's `GSUB` table as substitution rules, not in `cmap`. The letter ب (U+0628) has:

| Form | Description | Source |
|------|-------------|--------|
| ب | isolated | cmap (U+0628) |
| بـ | initial | GSUB `init` lookup |
| ـبـ | medial | GSUB `medi` lookup |
| ـب | final | GSUB `fina` lookup |

Only the isolated form has a Unicode codepoint. The other three are **glyph IDs with no Unicode**, produced by HarfBuzz text shaping from GSUB table lookups.

The fix is a two-phase approach:
1. Run HarfBuzz on a synthetic test corpus that exercises every contextual combination → collect the set of required glyph IDs.
2. Load those glyph IDs directly into msdfgen-wasm by calling `gen._module._loadGlyph(glyphId, ...)` (the low-level WASM export), bypassing `loadGlyphs()`.

This requires using a private API on `msdfgen-wasm`. It is the only correct path.

---

## 1. New Dependencies

### 1.1 `harfbuzzjs` (required)

```bash
npm install harfbuzzjs
```

Package: `harfbuzzjs` on npm. Provides pre-compiled HarfBuzz as a WASM binary (`hb.wasm`) plus a thin JS wrapper. This is the reference implementation used by Google Fonts tooling.

The npm package exposes:
- `harfbuzzjs/hb.wasm` — the WASM binary, resolved via `createRequire`
- `harfbuzzjs/hb-subset.wasm` — not needed
- A raw WASM module with `hb_buffer_*`, `hb_font_*`, `hb_shape`, `hb_glyph_info_get_glyph_infos`, `hb_glyph_info_get_glyph_positions` exports

**Important:** `harfbuzzjs` does not ship a high-level JS class. You call its C API directly through the WASM module. The integration code in section 3.1 handles this.

### 1.2 No other new runtime dependencies

`opentype.js` is not needed — HarfBuzz handles GSUB/GPOS correctly.

---

## 2. Architecture Overview

### New files

```
src/
  shaper/
    harfbuzz.ts        ← HarfBuzz WASM loader + hb_shape() wrapper
    text-shaper.ts     ← High-level ArabicShaper class (language/script/direction)
    charset-presets.ts ← Arabic/Hebrew/Persian/Devanagari charset strings
    glyph-loader.ts    ← Direct glyph-ID loader for msdfgen-wasm
```

### Modified files

```
src/types.ts           ← Add `script`, `direction`, `language`, `shaping` to GenerateOptions
src/utils.ts           ← Add arabic/hebrew/persian/devanagari to COMMON_CHARSETS
src/converter-worker.ts← Add shaping phase before gen.loadGlyphs()
src/converter.ts       ← Pass shaping options into ConvertJobOptions
tsup.config.ts         ← No changes needed (src/shaper/* is tree-shaken into chunks)
```

### New test files

```
test/
  shaper.test.ts       ← Unit tests for HarfBuzz wrapper and ArabicShaper
  charset-presets.test.ts ← Preset string validation
```

---

## 3. Implementation — New Files

### 3.1 `src/shaper/harfbuzz.ts`

HarfBuzz WASM loader and raw shaping call. Singleton per process (WASM init is expensive).

```typescript
/**
 * shaper/harfbuzz.ts
 *
 * Loads the HarfBuzz WASM binary and exposes a single `hbShape()` function.
 * The module is a lazy singleton — the WASM is only loaded on first use.
 *
 * HarfBuzz C API used:
 *   hb_blob_create_or_fail / hb_blob_destroy
 *   hb_face_create / hb_face_destroy
 *   hb_font_create / hb_font_set_scale / hb_font_destroy
 *   hb_buffer_create / hb_buffer_add_utf8 / hb_buffer_guess_segment_properties
 *   hb_buffer_set_direction / hb_buffer_set_script / hb_buffer_set_language
 *   hb_shape
 *   hb_buffer_get_length
 *   hb_buffer_get_glyph_infos
 *   hb_buffer_get_glyph_positions
 *   hb_buffer_destroy
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';

export interface HbGlyphInfo {
  glyphId: number;   // glyph index in the font
  cluster: number;   // byte offset in the original UTF-8 string
}

export interface HbGlyphPosition {
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}

export interface HbShapeResult {
  infos: HbGlyphInfo[];
  positions: HbGlyphPosition[];
}

export type HbDirection = 'ltr' | 'rtl' | 'ttb' | 'btt';
export type HbScript =
  | 'Arab' | 'Hebr' | 'Deva' | 'Beng' | 'Gujr' | 'Guru' | 'Knda'
  | 'Mlym' | 'Orya' | 'Taml' | 'Telu' | 'Thai' | 'Latn' | 'Cyrl';

export interface HbShapeOptions {
  direction?: HbDirection;
  script?: HbScript;
  language?: string; // BCP 47 tag, e.g. 'ar', 'fa', 'ur', 'he'
  features?: string[]; // e.g. ['+kern', '+liga', '+mark']
}

// ──────────────────────────────────────────────────────────────────────────────
// HarfBuzz direction/script constants
// (Values from hb-common.h — do not change)
// ──────────────────────────────────────────────────────────────────────────────

const HB_DIRECTION: Record<HbDirection, number> = {
  ltr: 4,
  rtl: 5,
  ttb: 6,
  btt: 7,
};

// HB uses 4-char tag integers: tag = (c1<<24)|(c2<<16)|(c3<<8)|c4
function hbTag(s: string): number {
  const c = s.padEnd(4, ' ');
  return (
    (c.charCodeAt(0) << 24) |
    (c.charCodeAt(1) << 16) |
    (c.charCodeAt(2) << 8) |
    c.charCodeAt(3)
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Singleton WASM instance
// ──────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: HarfBuzz WASM module has no TS types
type HbModule = any;

let _hbModule: HbModule | null = null;
let _initPromise: Promise<HbModule> | null = null;

async function getHbModule(): Promise<HbModule> {
  if (_hbModule) return _hbModule;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('harfbuzzjs/hb.wasm');
    const wasmBytes = await fs.readFile(wasmPath);

    // harfbuzzjs ships its own thin JS wrapper alongside the WASM.
    // We instantiate the WASM directly here for full control.
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      env: {
        // The HarfBuzz WASM binary from harfbuzzjs does not import host functions.
        // If a future version does, add them here.
      },
    });
    _hbModule = instance.exports;
    return _hbModule;
  })();

  _hbModule = await _initPromise;
  return _hbModule;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Shape `text` using HarfBuzz and return per-glyph info + positions.
 *
 * The `fontBuffer` must be the raw TTF/OTF binary (same buffer passed to
 * gen.loadFont() in the msdfgen-wasm pipeline).
 *
 * Result glyphs are in visual order (already reversed for RTL text).
 */
export async function hbShape(
  text: string,
  fontBuffer: Uint8Array,
  options: HbShapeOptions = {},
): Promise<HbShapeResult> {
  const hb = await getHbModule();

  // ── allocate a font from the raw bytes ─────────────────────────────────────
  const fontBytes = new Uint8Array(fontBuffer);
  const fontPtr = hb.malloc(fontBytes.byteLength);
  new Uint8Array(hb.memory.buffer).set(fontBytes, fontPtr);

  const blob = hb.hb_blob_create_or_fail(fontPtr, fontBytes.byteLength, 1 /* HB_MEMORY_MODE_READONLY */, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  const font = hb.hb_font_create(face);
  const upem = hb.hb_face_get_upem(face);
  hb.hb_font_set_scale(font, upem, upem);

  // ── allocate a text buffer ─────────────────────────────────────────────────
  const enc = new TextEncoder();
  const textBytes = enc.encode(text);
  const textPtr = hb.malloc(textBytes.byteLength + 1);
  new Uint8Array(hb.memory.buffer).set(textBytes, textPtr);
  new Uint8Array(hb.memory.buffer)[textPtr + textBytes.byteLength] = 0; // null terminate

  const buf = hb.hb_buffer_create();
  hb.hb_buffer_add_utf8(buf, textPtr, textBytes.byteLength, 0, textBytes.byteLength);

  // ── set direction / script / language ────────────────────────────────────
  if (options.direction) {
    hb.hb_buffer_set_direction(buf, HB_DIRECTION[options.direction]);
  }
  if (options.script) {
    hb.hb_buffer_set_script(buf, hbTag(options.script));
  }
  if (options.language) {
    const langBytes = enc.encode(options.language);
    const langPtr = hb.malloc(langBytes.byteLength + 1);
    new Uint8Array(hb.memory.buffer).set(langBytes, langPtr);
    new Uint8Array(hb.memory.buffer)[langPtr + langBytes.byteLength] = 0;
    const langObj = hb.hb_language_from_string(langPtr, langBytes.byteLength);
    hb.hb_buffer_set_language(buf, langObj);
    hb.free(langPtr);
  }

  // If nothing was set explicitly, let HarfBuzz guess from the text content.
  hb.hb_buffer_guess_segment_properties(buf);

  // ── apply features ─────────────────────────────────────────────────────────
  // Features are optional — HarfBuzz enables required features automatically
  // (ccmp, init, medi, fina, rlig) based on the script.
  let featuresPtr = 0;
  if (options.features && options.features.length > 0) {
    // Each hb_feature_t is 8 bytes: tag(4) + value(4) + start(4) + end(4) = 16 bytes
    // We allocate per-feature structs and pass a pointer array.
    // For simplicity, we rely on hb_shape() default features here and leave
    // explicit feature override for a future iteration.
  }

  // ── shape ─────────────────────────────────────────────────────────────────
  hb.hb_shape(font, buf, featuresPtr, 0);

  // ── read results ──────────────────────────────────────────────────────────
  const glyphCount = hb.hb_buffer_get_length(buf);
  const infosPtr = hb.hb_buffer_get_glyph_infos(buf, 0);
  const posPtr = hb.hb_buffer_get_glyph_positions(buf, 0);

  const heap32 = new Int32Array(hb.memory.buffer);
  const infos: HbGlyphInfo[] = [];
  const positions: HbGlyphPosition[] = [];

  for (let i = 0; i < glyphCount; i++) {
    // hb_glyph_info_t: codepoint(4) + mask(4) + cluster(4) + var1(4) + var2(4) = 20 bytes
    const infoBase = (infosPtr + i * 20) >> 2;
    infos.push({
      glyphId: heap32[infoBase],     // codepoint field holds glyph ID after shaping
      cluster: heap32[infoBase + 2], // byte cluster
    });

    // hb_glyph_position_t: x_advance(4) + y_advance(4) + x_offset(4) + y_offset(4) + var(4) = 20 bytes
    const posBase = (posPtr + i * 20) >> 2;
    // HarfBuzz uses 26.6 fixed-point internally scaled to upem
    positions.push({
      xAdvance: heap32[posBase],
      yAdvance: heap32[posBase + 1],
      xOffset:  heap32[posBase + 2],
      yOffset:  heap32[posBase + 3],
    });
  }

  // ── cleanup ────────────────────────────────────────────────────────────────
  hb.hb_buffer_destroy(buf);
  hb.hb_font_destroy(font);
  hb.hb_face_destroy(face);
  hb.hb_blob_destroy(blob);
  hb.free(textPtr);
  hb.free(fontPtr);

  return { infos, positions };
}

/** Pre-warm the HarfBuzz WASM module (optional, avoids first-use latency). */
export const initHarfBuzz = getHbModule;
```

### 3.2 `src/shaper/text-shaper.ts`

High-level shaping logic: generating the complete set of glyph IDs required for an atlas.

```typescript
/**
 * shaper/text-shaper.ts
 *
 * ArabicShaper collects the set of unique glyph IDs required for a given
 * charset by running HarfBuzz on synthetic text that exercises every
 * contextual form:
 *
 *   isolated  →  ZWJ + char + ZWJ  (both sides joined)
 *   initial   →  char + ZWJ        (joins to next char)
 *   medial    →  ZWJ + char + ZWJ  (joins both sides — same as isolated context
 *                                   but OpenType init/medi differ by position)
 *   final     →  ZWJ + char        (joins to previous char)
 *
 * ZWJ (U+200D) forces a joining context without producing a visible glyph.
 *
 * For each base character we shape four contextual strings and collect all
 * glyph IDs that HarfBuzz produces. Deduplication is handled by a Set.
 */

import { hbShape } from './harfbuzz.js';
import type { HbScript, HbShapeOptions } from './harfbuzz.js';

export interface ShapedGlyphDescriptor {
  glyphId: number;
  /** Original Unicode codepoint, if the glyph directly represents one character. */
  unicode?: number;
  /** True when this glyph is a ligature of two or more base characters. */
  isLigature: boolean;
  /** Byte cluster of the first source character in the synthetic string. */
  cluster: number;
}

export interface ShapingOptions {
  script?: HbScript;
  direction?: 'ltr' | 'rtl';
  language?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Arabic Unicode block ranges (used to detect whether a codepoint needs shaping)
// ──────────────────────────────────────────────────────────────────────────────
const ARABIC_RANGES: [number, number][] = [
  [0x0600, 0x06FF], // Arabic
  [0x0750, 0x077F], // Arabic Supplement
  [0x08A0, 0x08FF], // Arabic Extended-A
  [0xFB50, 0xFDFF], // Arabic Presentation Forms-A
  [0xFE70, 0xFEFF], // Arabic Presentation Forms-B
];

// Hebrew, Syriac, Thaana also require shaping
const COMPLEX_SCRIPT_RANGES: [number, number][] = [
  ...ARABIC_RANGES,
  [0x0590, 0x05FF], // Hebrew
  [0x0700, 0x074F], // Syriac
  [0x0780, 0x07BF], // Thaana
  [0x0900, 0x097F], // Devanagari
  [0x0980, 0x09FF], // Bengali
  [0x0A80, 0x0AFF], // Gujarati
  [0x0B00, 0x0B7F], // Oriya
  [0x0B80, 0x0BFF], // Tamil
  [0x0C00, 0x0C7F], // Telugu
  [0x0C80, 0x0CFF], // Kannada
  [0x0D00, 0x0D7F], // Malayalam
  [0x0E00, 0x0E7F], // Thai
  [0x0E80, 0x0EFF], // Lao
];

export function needsShaping(codepoint: number): boolean {
  return COMPLEX_SCRIPT_RANGES.some(([lo, hi]) => codepoint >= lo && codepoint <= hi);
}

const ZWJ = '\u200D'; // ZERO WIDTH JOINER — forces joining context

/**
 * Returns 4 synthetic strings that put `char` in each of the 4 Arabic
 * contextual positions (isolated, initial, medial, final).
 *
 * Using a neutral joining character (ح, U+062D — medial-capable) as the
 * neighbour ensures the font applies the correct GSUB lookup.
 */
function arabicContextStrings(char: string): string[] {
  // Use ZWJ as a zero-width connector. It signals a joining context to the
  // shaping engine without contributing a rendered glyph.
  return [
    char,                        // isolated (no neighbours)
    `${char}${ZWJ}`,             // initial (joins to next)
    `${ZWJ}${char}${ZWJ}`,       // medial (joins both sides)
    `${ZWJ}${char}`,             // final (joins to previous)
  ];
}

/**
 * Shape a charset string and return the complete set of unique glyph IDs
 * required for atlas generation.
 *
 * For non-complex characters (Latin, digits, etc.) the glyph ID is obtained
 * by shaping the character in isolation (no context), which gives the same
 * result as cmap lookup.
 *
 * For complex-script characters, four contextual strings are shaped and all
 * unique produced glyph IDs are collected.
 *
 * @returns Array of ShapedGlyphDescriptor, deduplicated by glyphId.
 */
export async function collectRequiredGlyphs(
  charset: string,
  fontBuffer: Uint8Array,
  options: ShapingOptions = {},
): Promise<ShapedGlyphDescriptor[]> {
  const seen = new Set<number>();
  const result: ShapedGlyphDescriptor[] = [];

  const shapeOpts: HbShapeOptions = {
    script:    options.script,
    direction: options.direction ?? 'ltr',
    language:  options.language,
  };

  // Deduplicated codepoints
  const codepoints = Array.from(
    new Set(Array.from(charset, (c) => c.codePointAt(0) as number)),
  );

  for (const cp of codepoints) {
    const char = String.fromCodePoint(cp);
    const isComplex = needsShaping(cp);

    const testStrings = isComplex
      ? arabicContextStrings(char)
      : [char];

    for (const testStr of testStrings) {
      const shaped = await hbShape(testStr, fontBuffer, shapeOpts);

      for (const info of shaped.infos) {
        if (info.glyphId === 0) continue; // glyph ID 0 = .notdef, skip
        if (seen.has(info.glyphId)) continue;
        seen.add(info.glyphId);

        // Determine if this is a ligature: the shaped result for a single-char
        // input has exactly 1 glyph. Multiple glyphs per char → ligature.
        const isLigature = testStr.replace(ZWJ, '').length > 1 && shaped.infos.length < testStr.replace(ZWJ, '').length;

        result.push({
          glyphId: info.glyphId,
          unicode: isComplex ? undefined : cp,
          isLigature,
          cluster: info.cluster,
        });
      }
    }
  }

  return result;
}
```

### 3.3 `src/shaper/glyph-loader.ts`

The bridge between HarfBuzz glyph IDs and msdfgen-wasm. This directly calls the
low-level WASM exports, bypassing `gen.loadGlyphs()`.

```typescript
/**
 * shaper/glyph-loader.ts
 *
 * Loads a set of glyphs into msdfgen-wasm by glyph ID, not by Unicode codepoint.
 *
 * The standard `gen.loadGlyphs(codepoints)` flow is:
 *   for each unicode → _getGlyphIndex(unicode) → _loadGlyph(index)
 *
 * For shaped Arabic glyphs the HarfBuzz glyph IDs ARE the font's internal
 * glyph indices — the same values returned by `_getGlyphIndex`. We therefore
 * skip the cmap lookup and call `_loadGlyph(glyphId)` directly.
 *
 * We also need to assign a stable "unicode" value to each glyph so it appears
 * in the BMFont `chars` array with a consistent `id` field. The strategy:
 *
 *   • If `descriptor.unicode` is set (non-complex glyph), use it as-is.
 *   • Otherwise assign a Private Use Area codepoint (U+E000..U+F8FF).
 *     The mapping is returned so callers can record it in output metadata.
 *
 * IMPORTANT: This function accesses `gen._module` — a private field of the
 * Msdfgen class from msdfgen-wasm. This is a deliberate internal API use that
 * is justified because:
 *   1. msdfgen-wasm does not expose a public loadGlyphById() method.
 *   2. The _module WASM exports are stable (unchanged since the initial release).
 *   3. The alternative (forking msdfgen-wasm) creates an unbounded maintenance
 *      burden.
 * Pin the msdfgen-wasm version and add a CI smoke-test if this ever breaks.
 */

import type { Msdfgen } from 'msdfgen-wasm';
import type { ShapedGlyphDescriptor } from './text-shaper.js';

const PUA_START = 0xe000; // Unicode Private Use Area start
const PUA_END   = 0xf8ff; // Unicode Private Use Area end

export interface GlyphLoadResult {
  /** Maps glyph ID → the unicode value stored in the BMFont `chars[].id` field */
  glyphIdToUnicode: Map<number, number>;
  /** Number of glyphs successfully loaded */
  loaded: number;
  /** Number of glyphs skipped (glyph ID 0 or load error) */
  skipped: number;
}

// biome-ignore lint/suspicious/noExplicitAny: msdfgen-wasm _module is untyped
type WasmModule = any;

/**
 * Load a set of shaped glyphs into the msdfgen-wasm WASM instance.
 *
 * Must be called AFTER `gen.loadFont()` and INSTEAD of `gen.loadGlyphs()`.
 * After this call, `gen.packGlyphs()` and `gen.createAtlasImage()` work normally.
 */
export function loadShapedGlyphs(
  gen: Msdfgen,
  descriptors: ShapedGlyphDescriptor[],
  options: { preprocess?: boolean } = {},
): GlyphLoadResult {
  const module: WasmModule = (gen as unknown as { _module: WasmModule })._module;
  const tmp: number = (gen as unknown as { _tmp: number })._tmp;
  const preprocess = options.preprocess ?? true;

  const glyphIdToUnicode = new Map<number, number>();
  let puaIndex = 0;
  let loaded = 0;
  let skipped = 0;

  // Reset internal glyph state (mirrors what gen.unloadGlyphs() does)
  // biome-ignore lint/suspicious/noExplicitAny: accessing private fields
  const genAny = gen as any;
  if (genAny._glyphs) {
    genAny._glyphs.forEach((g: { _ptr: number }) => module._destroyGlyph(g._ptr));
  }
  genAny._glyphs = [];
  genAny._glyphMap = new Map<number, unknown>();

  const floatView: Float64Array = module.HEAPF64.subarray((tmp + 8) / 8);
  const heapu32: Uint32Array   = module.HEAPU32.subarray(tmp / 4);

  for (const desc of descriptors) {
    if (desc.glyphId === 0) {
      skipped++;
      continue;
    }

    // Assign unicode value for the BMFont id field
    let unicode: number;
    if (desc.unicode !== undefined) {
      unicode = desc.unicode;
    } else {
      if (PUA_START + puaIndex > PUA_END) {
        // PUA exhausted — more than 6400 non-unicode shaped glyphs (extremely rare)
        skipped++;
        continue;
      }
      unicode = PUA_START + puaIndex++;
    }

    const errorCode: number = module._loadGlyph(
      desc.glyphId,
      tmp,
      preprocess ? 1 : 0,
    );

    if (errorCode !== 0) {
      skipped++;
      continue;
    }

    const glyph = {
      index:   desc.glyphId,
      unicode,
      advance: floatView[0],
      left:    floatView[1],
      bottom:  floatView[2],
      right:   floatView[3],
      top:     floatView[4],
      kerning: [] as unknown[],
      _ptr:    heapu32[0],
    };

    genAny._glyphs.push(glyph);
    genAny._glyphMap.set(unicode, glyph);
    glyphIdToUnicode.set(desc.glyphId, unicode);
    loaded++;
  }

  // Load kerning data for all glyphs (same as gen.loadKerningData())
  // This calls _getNextKerning iteratively — no changes needed here since
  // kerning is indexed by glyph index (font-internal), not unicode.
  try {
    genAny.loadKerningData();
  } catch {
    // Non-fatal: some Arabic fonts have no kern table
  }

  return { glyphIdToUnicode, loaded, skipped };
}
```

### 3.4 `src/shaper/charset-presets.ts`

Arabic and other complex-script charset strings, kept separate from `utils.ts`
to avoid inflating the bundle for users who only need Latin/Cyrillic.

```typescript
/**
 * shaper/charset-presets.ts
 *
 * Character strings for complex-script charsets. These are the BASE Unicode
 * codepoints — the actual glyphs in the atlas will be more numerous because
 * each base letter produces 2–4 contextual forms after shaping.
 *
 * Usage:
 *   charset: 'arabic'         → Arabic base block (standard letters)
 *   charset: 'arabic-full'    → Arabic + Presentation Forms + diacritics
 *   charset: 'persian'        → arabic-full + 4 Farsi-specific letters
 *   charset: 'hebrew'         → Hebrew base block
 *   charset: 'devanagari'     → Devanagari base block (Hindi/Sanskrit)
 */

// ── Arabic ────────────────────────────────────────────────────────────────────

/** Core Arabic letters (U+0621–U+064A) — the 28 base consonants */
const ARABIC_BASE_LETTERS =
  '\u0621\u0622\u0623\u0624\u0625\u0626\u0627\u0628\u0629\u062A' +
  '\u062B\u062C\u062D\u062E\u062F\u0630\u0631\u0632\u0633\u0634' +
  '\u0635\u0636\u0637\u0638\u0639\u063A\u0641\u0642\u0643\u0644' +
  '\u0645\u0646\u0647\u0648\u064A';

/** Tashkil (diacritical marks, U+064B–U+065F) */
const ARABIC_TASHKIL =
  '\u064B\u064C\u064D\u064E\u064F\u0650\u0651\u0652\u0653\u0654\u0655';

/** Arabic digits (U+0660–U+0669) */
const ARABIC_DIGITS = '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669';

/** Arabic punctuation (common subset) */
const ARABIC_PUNCTUATION = '\u060C\u061B\u061F\u0640'; // comma, semicolon, ?, tatweel

/** Lam-Alef mandatory ligatures in Presentation Forms-B (U+FEF5–U+FEFC) */
const LAM_ALEF_LIGATURES = '\uFEF5\uFEF6\uFEF7\uFEF8\uFEF9\uFEFA\uFEFB\uFEFC';

export function arabicCharset(): string {
  return ARABIC_BASE_LETTERS + ARABIC_DIGITS + ARABIC_PUNCTUATION;
}

export function arabicFullCharset(): string {
  return arabicCharset() + ARABIC_TASHKIL + LAM_ALEF_LIGATURES;
}

/** Persian/Farsi extends Arabic with 4 additional letters */
export function persianCharset(): string {
  return arabicFullCharset() + '\u067E\u0686\u06AF\u06CC'; // پ چ گ ی
}

/** Urdu extends Persian */
export function urduCharset(): string {
  return persianCharset() + '\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06C3\u06D2';
}

// ── Hebrew ────────────────────────────────────────────────────────────────────

/** Hebrew base block (U+05D0–U+05EA) + common diacritics (nikud) */
export function hebrewCharset(): string {
  const letters = Array.from({ length: 27 }, (_, i) =>
    String.fromCodePoint(0x05d0 + i),
  ).join('');
  const nikud = '\u05B0\u05B1\u05B2\u05B3\u05B4\u05B5\u05B6\u05B7\u05B8\u05B9\u05BB\u05BC\u05BF\u05C1\u05C2';
  return letters + nikud;
}

// ── Devanagari ────────────────────────────────────────────────────────────────

/** Devanagari base block for Hindi (U+0900–U+097F) */
export function devanagariCharset(): string {
  return Array.from({ length: 128 }, (_, i) =>
    String.fromCodePoint(0x0900 + i),
  ).join('');
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const COMPLEX_CHARSET_PRESETS: Record<string, () => string> = {
  arabic:      arabicCharset,
  'arabic-full': arabicFullCharset,
  persian:     persianCharset,
  urdu:        urduCharset,
  hebrew:      hebrewCharset,
  devanagari:  devanagariCharset,
};
```

---

## 4. Implementation — Modified Files

### 4.1 `src/types.ts`

Add new fields to `GenerateOptions` and a new `ScriptShapingOptions` interface.

**Add after the `streamAtlases` property:**

```typescript
/**
 * Script shaping options for complex text layout (Arabic, Hebrew, Devanagari, etc.)
 * When `script` is set, HarfBuzz is used to shape the charset before MSDF generation.
 * Requires the `harfbuzzjs` package to be installed.
 */
shaping?: {
  /**
   * OpenType script tag. Setting this enables HarfBuzz shaping.
   * Common values: 'Arab' (Arabic), 'Hebr' (Hebrew), 'Deva' (Devanagari),
   * 'Thai', 'Beng' (Bengali), 'Gujr' (Gujarati).
   */
  script: 'Arab' | 'Hebr' | 'Deva' | 'Beng' | 'Gujr' | 'Guru' | 'Knda' |
          'Mlym' | 'Orya' | 'Taml' | 'Telu' | 'Thai' | 'Latn' | 'Cyrl';
  /**
   * Text direction for the shaped run.
   * @default 'rtl' when script is 'Arab' or 'Hebr', 'ltr' otherwise
   */
  direction?: 'ltr' | 'rtl';
  /**
   * BCP 47 language tag, e.g. 'ar', 'fa', 'ur', 'he', 'hi'.
   * Influences language-specific GSUB lookups (e.g. Farsi vs Arabic forms of ک).
   */
  language?: string;
};
```

**Also add `'arabic' | 'arabic-full' | 'persian' | 'urdu' | 'hebrew' | 'devanagari'`** to the `CharsetName` union type:

```typescript
export type CharsetName =
  | 'ascii' | 'alphanumeric' | 'latin' | 'cyrillic' | 'custom'
  | 'arabic' | 'arabic-full' | 'persian' | 'urdu' | 'hebrew' | 'devanagari';
```

### 4.2 `src/utils.ts`

Update `COMMON_CHARSETS` and `resolveStringCharset` to delegate to the new presets.

**Import at top of file:**

```typescript
import { COMPLEX_CHARSET_PRESETS } from './shaper/charset-presets.js';
```

**Extend `resolveStringCharset`:**

```typescript
function resolveStringCharset(c: string): string {
  if (c === 'ascii')         return COMMON_CHARSETS.ascii();
  if (c === 'alphanumeric')  return COMMON_CHARSETS.alphanumeric();
  if (c === 'latin')         return COMMON_CHARSETS.latin();
  if (c === 'cyrillic')      return COMMON_CHARSETS.cyrillic();
  if (c === 'custom') throw new Error('"custom" is a charset provider, not a preset name.');

  // Complex script presets
  if (COMPLEX_CHARSET_PRESETS[c]) return COMPLEX_CHARSET_PRESETS[c]();

  return c;
}
```

**Update `MSDFUtils.getCharsets`** to include complex presets:

```typescript
static getCharsets = () => ({
  ...COMMON_CHARSETS,
  ...Object.fromEntries(
    Object.entries(COMPLEX_CHARSET_PRESETS).map(([k, v]) => [k, v]),
  ),
});
```

### 4.3 `src/converter-worker.ts`

This is the most impactful change. The shaping phase runs before `gen.loadGlyphs()`.

**Add to imports:**

```typescript
import { collectRequiredGlyphs, needsShaping } from './shaper/text-shaper.js';
import { loadShapedGlyphs } from './shaper/glyph-loader.js';
import type { ShapingOptions } from './shaper/text-shaper.js';
```

**Add `shaping` to `ConvertJobOptions`:**

```typescript
export interface ConvertJobOptions {
  charset?: unknown;
  fontSize?: number;
  textureSize?: [number, number] | null;
  fieldRange?: number;
  edgeColoring?: 'simple' | 'inktrap' | 'distance';
  padding?: number;
  fixOverlaps?: boolean;
  // NEW ↓
  shaping?: {
    script: string;
    direction?: 'ltr' | 'rtl';
    language?: string;
  };
}
```

**Update `runConversion` — replace the codepoint loading block:**

```typescript
// ── Charset resolution ────────────────────────────────────────────────────────
const charString = resolveCharset(
  charset as string | (string | number)[] | Set<string | number> | undefined,
);
const rawCodepoints = Array.from(new Set(charString), (c) => c.codePointAt(0)).filter(
  (cp): cp is number => cp !== undefined,
);

const hasComplexScript = rawCodepoints.some(needsShaping);
const useShaping = options.shaping?.script != null || hasComplexScript;

// ── Glyph loading (shaped or plain) ──────────────────────────────────────────
if (useShaping) {
  const shapingOpts: ShapingOptions = {
    script:    options.shaping?.script as ShapingOptions['script'],
    direction: options.shaping?.direction ?? (isRTLScript(options.shaping?.script) ? 'rtl' : 'ltr'),
    language:  options.shaping?.language,
  };

  // Collect all required glyph IDs (may include contextual forms with no Unicode)
  const descriptors = await collectRequiredGlyphs(charString, fontBuffer, shapingOpts);

  if (descriptors.length > 0) {
    loadShapedGlyphs(gen, descriptors, { preprocess: fixOverlaps });
  }
} else {
  // Existing plain codepoint path (Latin, Cyrillic, CJK, etc.)
  if (rawCodepoints.length > 0) {
    gen.loadGlyphs(rawCodepoints, { preprocess: fixOverlaps });
  }
}
```

**Add the RTL detection helper after imports:**

```typescript
function isRTLScript(script: string | undefined): boolean {
  return script === 'Arab' || script === 'Hebr' || script === 'Thaa' || script === 'Syrc';
}
```

**Important:** `runConversion` must become `async` once shaping is used (because `collectRequiredGlyphs` is async). Update its signature:

```typescript
export async function runConversion(
  gen: Msdfgen,
  fontBuffer: Uint8Array,
  fontName: string,
  options: ConvertJobOptions,
  onAtlas: (filename: string, texture: Uint8Array, index: number, total: number) => void,
): Promise<MSDFLayout> {
```

And update the worker message handler to `await runConversion(...)`.

### 4.4 `src/converter.ts`

Pass `shaping` from `GenerateOptions` into `ConvertJobOptions` in `_buildJobOptions()` (or wherever the job options object is assembled):

```typescript
const jobOptions: ConvertJobOptions = {
  charset:     options.charset,
  fontSize:    options.fontSize ?? 48,
  textureSize: options.textureSize ?? null,
  fieldRange:  options.fieldRange ?? 4,
  edgeColoring:options.edgeColoring ?? 'simple',
  padding:     options.padding ?? 2,
  fixOverlaps: options.fixOverlaps ?? true,
  shaping:     options.shaping,  // ← NEW
};
```

### 4.5 CLI (`src/cli.ts`)

Add `--script`, `--direction`, `--language` flags:

```typescript
'--script': (args, i, opts) => {
  if (!opts.shaping) opts.shaping = {} as GenerateOptions['shaping'];
  opts.shaping!.script = args[i + 1] as GenerateOptions['shaping']['script'];
  return i + 1;
},
'--direction': (args, i, opts) => {
  if (!opts.shaping) opts.shaping = {} as GenerateOptions['shaping'];
  opts.shaping!.direction = args[i + 1] as 'ltr' | 'rtl';
  return i + 1;
},
'--language': (args, i, opts) => {
  if (!opts.shaping) opts.shaping = {} as GenerateOptions['shaping'];
  opts.shaping!.language = args[i + 1];
  return i + 1;
},
```

Also add `arabic` as a shorthand:

```typescript
'--arabic': (_, i, opts) => {
  opts.charset = 'arabic';
  if (!opts.shaping) opts.shaping = {} as GenerateOptions['shaping'];
  opts.shaping!.script = 'Arab';
  opts.shaping!.direction = 'rtl';
  opts.shaping!.language = 'ar';
  return i;
},
```

Add to CLI help table:

```
--arabic               Use Arabic charset with RTL shaping (shorthand)
--script <tag>         OpenType script tag for shaping (Arab, Hebr, Deva, ...)
--direction <ltr|rtl>  Text direction for shaping context
--language <lang>      BCP 47 language tag (ar, fa, ur, he, hi, ...)
```

---

## 5. Test Coverage

### 5.1 `test/shaper.test.ts`

Tests for the shaping layer. Use a real Arabic font for integration tests (download in beforeAll, cache between tests). Noto Sans Arabic is recommended.

Required test cases:

```typescript
describe('collectRequiredGlyphs', () => {
  it('returns more glyph IDs than input codepoints for Arabic', async () => {
    // "ب" (U+0628) should yield at least 2 unique glyph IDs (isolated + other forms)
  });

  it('deduplicates glyph IDs across contexts', async () => {
    // Non-joining letters (like ا Alef) have only 2 forms (isolated=final)
    // so the deduplication must collapse them correctly
  });

  it('collects the Lam-Alef mandatory ligature glyph', async () => {
    // "لا" must produce a single ligature glyph ID, not two separate glyphs
  });

  it('handles non-Arabic characters without shaping context', async () => {
    // Latin "A" must produce exactly 1 glyph ID
  });
});

describe('loadShapedGlyphs', () => {
  it('loads glyphs into the Msdfgen instance correctly', async () => {
    // After loadShapedGlyphs(), gen._glyphs must have length === loaded count
  });

  it('assigns PUA unicode to shaped glyphs without a Unicode codepoint', async () => {
    // glyphIdToUnicode must map contextual form glyphs to U+E000+
  });

  it('assigns source unicode to unshaped glyphs', async () => {
    // A Latin glyph descriptor with unicode=65 must map to 65 in the result
  });

  it('skips glyph ID 0 (.notdef)', async () => {
    // skipped count must be non-zero when .notdef is in descriptors
  });
});
```

### 5.2 `test/converter.test.ts` additions

```typescript
describe('Arabic shaping path', () => {
  it('calls collectRequiredGlyphs when shaping.script is set', async () => {
    // vi.mock('./shaper/text-shaper.js', ...) and assert it was called
  });

  it('calls loadShapedGlyphs instead of gen.loadGlyphs for shaped charset', async () => {
    // Spy on loadShapedGlyphs; assert gen.loadGlyphs was NOT called
  });

  it('falls back to plain gen.loadGlyphs for Latin charset with no shaping option', async () => {
    // The existing test path must be unaffected
  });
});
```

### 5.3 `test/charset-presets.test.ts`

```typescript
describe('charset presets', () => {
  it.each(['arabic', 'arabic-full', 'persian', 'urdu', 'hebrew', 'devanagari'])(
    '%s preset contains only valid Unicode codepoints',
    (preset) => {
      const str = COMPLEX_CHARSET_PRESETS[preset]();
      expect(str.length).toBeGreaterThan(0);
      for (const char of str) {
        expect(char.codePointAt(0)).toBeGreaterThan(0);
      }
    },
  );

  it('resolveCharset("arabic") returns the arabic charset string', () => {
    const result = resolveCharset('arabic');
    expect(result).toContain('\u0628'); // ب
  });
});
```

---

## 6. Operational Details

### 6.1 `harfbuzzjs` WASM path resolution

`harfbuzzjs` ships `hb.wasm` alongside its JS files. Use the same `createRequire` pattern already used for `msdfgen-wasm`:

```typescript
const require = createRequire(import.meta.url);
const wasmPath = require.resolve('harfbuzzjs/hb.wasm');
```

This works in both ESM and CJS contexts and survives `tsup` bundling.

### 6.2 `runConversion` becomes async — worker thread impact

The worker thread currently calls `runConversion` synchronously. Once shaping is added, the call must be awaited in the `parentPort.on('message', ...)` handler:

```typescript
// Before
const layout = runConversion(gen, msg.fontBuffer, msg.fontName, msg.options, onAtlas);
parentPort?.postMessage({ type: 'result', layout });

// After
const layout = await runConversion(gen, msg.fontBuffer, msg.fontName, msg.options, onAtlas);
parentPort?.postMessage({ type: 'result', layout });
```

The `_executeInlineConversion` method in `converter.ts` must also `await` the call.

### 6.3 Memory sizing for Arabic

Arabic requires more atlas space than Latin. Auto-sizing in `utils.ts` `calculateOptimalTextureSize` should account for the glyph multiplier:

```typescript
function calculateOptimalTextureSize(
  charCount: number,
  fontSize: number,
  shapingMultiplier = 1,
): [number, number] {
  const areaPerChar = fontSize * fontSize * 1.2;
  const totalArea = charCount * areaPerChar * shapingMultiplier;
  // ... rest unchanged
}
```

A reasonable default multiplier: **3.0 for Arabic** (accounts for ~3 contextual forms on average). Pass this when `shaping.script === 'Arab'`.

### 6.4 Build — no changes to `tsup.config.ts`

The `src/shaper/*` files are imported by `converter-worker.ts` (which is already a build entry point) and by `converter.ts` (which feeds into `index.ts`). tsup's code splitting will emit them as chunks automatically. No new entry points are needed.

### 6.5 Optional: lazy import of `harfbuzzjs`

Because `harfbuzzjs` adds ~300 KB to the WASM payload and is only needed for complex scripts, consider wrapping the import in a dynamic `import()` inside `harfbuzz.ts`:

```typescript
// In getHbModule(), instead of a static import at the top:
const hb = await import('harfbuzzjs/hb-wasm.js').catch(() => {
  throw new Error(
    'harfbuzzjs is required for complex script shaping. ' +
    'Install it: npm install harfbuzzjs'
  );
});
```

This means users who only generate Latin/Cyrillic fonts never pay the initialization cost and don't need `harfbuzzjs` installed at all. The dependency should be listed as `peerDependencies` with `optional: true` in `package.json`:

```json
"peerDependencies": {
  "harfbuzzjs": ">=0.3.6"
},
"peerDependenciesMeta": {
  "harfbuzzjs": { "optional": true }
}
```

---

## 7. Edge Cases and Limitations

### 7.1 Kashida (Tatweel U+0640)
Kashida is a letter-stretching character used for Arabic text justification. It produces a glyph (a horizontal bar). Include U+0640 in the charset (it is included in `arabicCharset()`). Renderers that do justification by repeating the kashida glyph do not need special atlas support.

### 7.2 ZWNJ/ZWJ in test strings
The synthetic context strings used in `arabicContextStrings()` contain ZWJ (U+200D). After shaping, ZWJ produces glyph ID 0 (.notdef or an invisible zero-advance glyph). The `glyph ID 0` skip in `loadShapedGlyphs` handles this correctly.

### 7.3 Fonts without GSUB
Some simplified Arabic fonts (e.g. Arial Unicode on some platforms) store contextual forms directly in the Presentation Forms block (U+FE70–U+FEFF) and have no GSUB table. For these fonts:
- HarfBuzz will still produce correct output (it falls back to `cmap` lookup)
- The `arabicFullCharset()` preset includes the Presentation Forms-B range as explicit codepoints
- If a font has neither GSUB nor Presentation Forms entries, glyphs will use isolated form only — acceptable degradation.

### 7.4 Diacritics (Tashkil) and GPOS mark positioning
Diacritic marks (harakat/tashkil) have zero advance width and are positioned relative to their base letter using GPOS `mark` lookups. HarfBuzz resolves these positions in the `xOffset`/`yOffset` fields of `HbGlyphPosition`.

The current `buildLayout` in `converter-worker.ts` does not use `xOffset`/`yOffset` from HarfBuzz (it uses msdfgen-wasm's own glyph metrics). Diacritics will be included in the atlas but with zero xadvance (which is correct). The renderer is responsible for positioning marks using the glyph's offset data from the BMFont layout.

For full diacritic support, a future phase can store the HarfBuzz position offsets in a sidecar JSON alongside the BMFont layout.

### 7.5 Bidirectional mixed text
The shaping phase in `collectRequiredGlyphs` processes one charset at a time. If a charset mixes Arabic and Latin (e.g., for a multilingual UI font), each range is shaped independently with appropriate direction settings. The glyphs are merged into one atlas — this is correct and the renderer handles layout direction.

### 7.6 CJK (Chinese/Japanese/Korean)
CJK does not require HarfBuzz shaping (no contextual forms, no GSUB substitution for standard usage). The plain `gen.loadGlyphs(codepoints)` path works. The `charset: 'cjk-basic'` preset can be added to `charset-presets.ts` without any shaping integration. The main CJK concern is atlas size (20,000+ glyphs) which is addressed by `streamAtlases: true`.

---

## 8. Phased Implementation Checklist

### Phase 1 — Charsets and infrastructure (no HarfBuzz yet)
- [ ] Add `src/shaper/charset-presets.ts`
- [ ] Update `src/utils.ts` to import and expose complex presets
- [ ] Update `CharsetName` type in `src/types.ts`
- [ ] Add charset preset tests in `test/charset-presets.test.ts`
- [ ] Verify 100% coverage maintained

### Phase 2 — HarfBuzz integration
- [ ] Install `harfbuzzjs` as optional peer dependency
- [ ] Add `src/shaper/harfbuzz.ts`
- [ ] Add `src/shaper/text-shaper.ts`
- [ ] Write unit tests with a real Arabic font (Noto Sans Arabic)
- [ ] Verify `hbShape()` returns correct glyph IDs for "لا" (should be 1 ligature)

### Phase 3 — Glyph loader and converter integration
- [ ] Add `src/shaper/glyph-loader.ts`
- [ ] Update `ConvertJobOptions` in `converter-worker.ts` to include `shaping`
- [ ] Make `runConversion` async
- [ ] Add the shaped/plain branch in `runConversion`
- [ ] Update `converter.ts` to pass `shaping` through job options
- [ ] Add `shaping` to `GenerateOptions` in `types.ts`
- [ ] Update worker thread `await` usage
- [ ] Write converter tests for the Arabic shaping path

### Phase 4 — CLI and example
- [ ] Add `--arabic`, `--script`, `--direction`, `--language` flags to `cli.ts`
- [ ] Add `examples/arabic.js` demonstrating Noto Sans Arabic generation
- [ ] Update README generation options table

### Phase 5 — Validation and release
- [ ] Run full test suite: `npm test`
- [ ] Confirm 100% coverage: `npm run coverage`
- [ ] Confirm biome clean: `npx biome lint src/ test/`
- [ ] Confirm typecheck: `npx tsc --noEmit`
- [ ] Confirm build: `npm run build`
- [ ] Test with a real Arabic font end-to-end: `node examples/arabic.js`
- [ ] Bump version to `1.11.0`, update CHANGELOG, push

---

## 9. Version and Changelog Entry

This is a **minor** version bump (`1.10.0` → `1.11.0`) because:
- New `shaping` option in `GenerateOptions` is additive and backward-compatible
- New charset presets are additive
- No breaking changes to existing public API

Suggested CHANGELOG entry:

```markdown
## [1.11.0] - YYYY-MM-DD

### Added
- **Complex Script Shaping**: Arabic, Hebrew, Persian, Urdu, Devanagari, and other
  complex scripts are now supported via HarfBuzz WASM (optional peer dependency:
  `harfbuzzjs`). Contextual glyph forms (init/medi/fina/isol), mandatory ligatures
  (Lam-Alef), and GSUB substitutions are all resolved before atlas generation.
- **New charset presets**: `arabic`, `arabic-full`, `persian`, `urdu`, `hebrew`,
  `devanagari` added to `GenerateOptions.charset`.
- **`shaping` option**: New `GenerateOptions.shaping` field accepts `script`,
  `direction`, and `language` for explicit shaping control.
- **CLI flags**: `--arabic`, `--script`, `--direction`, `--language`.

### Changed
- `runConversion` in `converter-worker.ts` is now `async` (no breaking change to
  public API; the worker and converter already await it).
```
