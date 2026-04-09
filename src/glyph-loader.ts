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
const PUA_END = 0xf8ff; // Unicode Private Use Area end (6399 slots)

export interface GlyphLoadResult {
  glyphIdToUnicode: Map<number, number>; // glyph ID → BMFont `id` value
  loaded: number;
  skipped: number;
}

// biome-ignore lint/suspicious/noExplicitAny: msdfgen-wasm internals are untyped
type WasmModule = any;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetGlyphs(g: WasmModule, module: WasmModule): void {
  if (!g._glyphs) {
    g._glyphs = [];
    g._glyphMap = new Map<number, unknown>();
    return;
  }
  for (const glyph of g._glyphs) module._destroyGlyph(glyph._ptr);
  g._glyphs = [];
  g._glyphMap = new Map<number, unknown>();
}

function resolveUnicode(
  glyphId: number,
  glyphIdToCodepoint: Map<number, number>,
  puaIndex: number,
): { unicode: number; newPuaIndex: number } | null {
  const unicode = glyphIdToCodepoint.get(glyphId);
  if (unicode !== undefined) return { unicode, newPuaIndex: puaIndex };
  if (PUA_START + puaIndex > PUA_END) return null; // PUA exhausted
  return { unicode: PUA_START + puaIndex, newPuaIndex: puaIndex + 1 };
}

// ── Public API ────────────────────────────────────────────────────────────────

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
  options: { preprocess?: boolean; advances?: Map<number, number> } = {},
): GlyphLoadResult {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private fields
  const g = gen as any;
  const module: WasmModule = g._module;
  const tmp: number = g._tmp;
  const preprocess = options.preprocess ?? true;
  const customAdvances = options.advances || new Map<number, number>();

  resetGlyphs(g, module);

  const glyphIdToUnicode = new Map<number, number>();
  let puaIndex = 0;
  let loaded = 0;
  let skipped = 0;

  for (const glyphId of glyphIds) {
    if (glyphId === 0) {
      skipped++;
      continue;
    }

    const errorCode: number = module._loadGlyph(glyphId, tmp, preprocess ? 1 : 0);
    if (errorCode !== 0) {
      skipped++;
      continue;
    }

    // Re-create views after _loadGlyph because WASM memory may have grown
    const floatView = new Float64Array(module.HEAPF64.buffer, tmp + 8, 5);
    const heapu32 = new Uint32Array(module.HEAPU32.buffer, tmp, 1);

    const res = resolveUnicode(glyphId, glyphIdToCodepoint, puaIndex);
    if (!res) {
      skipped++;
      continue;
    }

    const { unicode, newPuaIndex } = res;
    puaIndex = newPuaIndex;

    const advance = customAdvances.has(glyphId)
      ? (customAdvances.get(glyphId) as number)
      : floatView[0];

    const glyph = {
      index: glyphId,
      unicode,
      advance,
      left: floatView[1],
      bottom: floatView[2],
      right: floatView[3],
      top: floatView[4],
      kerning: [] as unknown[],
      _ptr: heapu32[0],
    };

    g._glyphs.push(glyph);
    g._glyphMap.set(unicode, glyph);
    glyphIdToUnicode.set(glyphId, unicode);
    loaded++;
  }

  // Load kerning (indexed by glyph index, not unicode — no changes needed)
  try {
    g.loadKerningData();
  } catch {
    /* Non-fatal: some Arabic fonts have no kern */
  }

  return { glyphIdToUnicode, loaded, skipped };
}

/**
 * Append additional glyphs (by Unicode codepoint) to an already-populated
 * Msdfgen instance WITHOUT resetting the existing glyph list.
 *
 * `gen.loadGlyphs()` always calls `unloadGlyphs()` first, which destroys any
 * glyphs previously loaded by `loadGlyphsByIds`. Call this instead to add
 * plain Unicode glyphs (Latin, Hebrew, etc.) after Arabic PUA glyphs have
 * already been loaded via `loadGlyphsByIds`.
 *
 * Skips codepoints already present in `gen._glyphMap` to avoid duplicates.
 */
export function appendUnicodeGlyphs(
  gen: Msdfgen,
  codepoints: number[],
  options: { preprocess?: boolean } = {},
): { loaded: number; skipped: number } {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private fields
  const g = gen as any;
  const module: WasmModule = g._module;
  const tmp: number = g._tmp;
  const preprocess = options.preprocess ?? true;

  if (!g._glyphs) g._glyphs = [];
  if (!g._glyphMap) g._glyphMap = new Map<number, unknown>();

  let loaded = 0;
  let skipped = 0;

  for (const unicode of codepoints) {
    // Skip if already loaded (e.g., isolated Arabic letter that also appears as a codepoint)
    if (g._glyphMap.has(unicode)) {
      skipped++;
      continue;
    }

    const index: number = module._getGlyphIndex(unicode);
    if (index === 0) {
      skipped++;
      continue;
    }

    const errorCode: number = module._loadGlyph(index, tmp, preprocess ? 1 : 0);
    if (errorCode !== 0) {
      skipped++;
      continue;
    }

    // Re-create views after _loadGlyph because WASM memory may have grown
    const floatView = new Float64Array(module.HEAPF64.buffer, tmp + 8, 5);
    const heapu32 = new Uint32Array(module.HEAPU32.buffer, tmp, 1);

    const glyph = {
      index,
      unicode,
      advance: floatView[0],
      left: floatView[1],
      bottom: floatView[2],
      right: floatView[3],
      top: floatView[4],
      kerning: [] as unknown[],
      _ptr: heapu32[0],
    };

    g._glyphs.push(glyph);
    g._glyphMap.set(unicode, glyph);
    loaded++;
  }

  return { loaded, skipped };
}
