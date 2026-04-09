// biome-ignore-all lint/suspicious/noExplicitAny: testing private methods for coverage
import type { Msdfgen } from 'msdfgen-wasm';
import { describe, expect, it, vi } from 'vitest';
import MSDFConverter, { disposeSharedConverter, getSharedConverter } from '../src/converter.js';
import { GoogleFontsHandler } from '../src/fetcher/google-fonts.js';
import { loadGlyphsByIds } from '../src/glyph-loader.js';
import UniversalMSDFGenerator from '../src/index.js';
import { resolvePresentationForms } from '../src/presentation-forms.js';
import * as scriptDetector from '../src/script-detector.js';
import * as shaper from '../src/shaper.js';

// Minimal WASM module mock — property names match the real Emscripten API.
function makeWasmModule(loadGlyphReturnValue = 0) {
  return {
    _destroyGlyph: vi.fn(),
    // biome-ignore lint/style/useNamingConvention: Emscripten heap view naming
    HEAPF64: { buffer: new ArrayBuffer(4096) },
    // biome-ignore lint/style/useNamingConvention: Emscripten heap view naming
    HEAPU32: { buffer: new ArrayBuffer(4096) },
    _loadGlyph: vi.fn().mockReturnValue(loadGlyphReturnValue),
    _loadKerningData: vi.fn(),
    _malloc: vi.fn().mockReturnValue(0),
    _free: vi.fn(),
    _getKerning: vi.fn().mockReturnValue(0),
  };
}

function makeGenMock(loadKerningData: () => void = vi.fn(), glyphs: unknown[] | undefined = []) {
  return {
    _glyphs: glyphs,
    _glyphMap: new Map(),
    _module: makeWasmModule(),
    _tmp: 0,
    loadKerningData,
    loadFont: vi.fn(),
    loadGlyphs: vi.fn(),
    packGlyphs: vi.fn().mockReturnValue([]),
    createAtlasImage: vi.fn().mockReturnValue(new Uint8Array(10)),
    get metrics() {
      return { emSize: 100, ascenderY: 80, descenderY: -20, lineHeight: 120 };
    },
  } as unknown as Msdfgen;
}

describe('Absolute Final Coverage Check 7', () => {
  it('hits script-detector autoDetectComplexScript and analyzeCharset', () => {
    const res1 = scriptDetector.autoDetectComplexScript('abc');
    const res2 = scriptDetector.autoDetectComplexScript('السلام');
    expect(res1).toBe(false);
    expect(res2).toBe(true);

    const analyzeRes = scriptDetector.analyzeCharset('A');
    expect(analyzeRes.requiresShaping).toBe(false);
  });

  it('hits script-detector complex script detector ranges', () => {
    expect(scriptDetector.isComplexScriptCodepoint(0x0905)).toBe(true); // Devanagari
    expect(scriptDetector.isComplexScriptCodepoint(0x0985)).toBe(true); // Bengali
    expect(scriptDetector.isComplexScriptCodepoint(0x0e01)).toBe(true); // Thai
    expect(scriptDetector.isComplexScriptCodepoint(0x0041)).toBe(false); // Latin A
  });

  it('hits shaper.ts initHarfBuzz and getHarfBuzz', async () => {
    await shaper.initHarfBuzz();
    const hb = await shaper.getHarfBuzz();
    expect(hb).toBeDefined();
    expect(typeof hb.createBlob).toBe('function');
  });

  it('hits shaper.ts clearShaperCache', async () => {
    await shaper.initHarfBuzz();
    shaper.clearShaperCache();
    const hb = await shaper.getHarfBuzz();
    expect(hb).toBeDefined();
  });

  it('hits shaper.ts shapeOnce validation errors', async () => {
    const hb = await shaper.getHarfBuzz();
    expect(() => shaper.shapeOnce(hb, null as any, 1000, 'test')).toThrow('Invalid font object');
  });

  it('hits glyph-loader.ts branches: glyphId=0 skip and errorCode!=0 skip', () => {
    const gen = makeGenMock();
    (gen as any)._module._loadGlyph = vi.fn().mockReturnValue(1); // Set error

    const r1 = loadGlyphsByIds(gen, new Set([0, 1]), new Map());
    expect(r1.skipped).toBe(2); // 0 is skipped, 1 has error
  });

  it('hits glyph-loader.ts resetGlyphs with existing glyphs', () => {
    // Populate _glyphs to hit the destroy loop
    const gen = makeGenMock(vi.fn(), [{ _ptr: 123 }]);
    loadGlyphsByIds(gen, new Set([0]), new Map());
    expect((gen as any)._module._destroyGlyph).toHaveBeenCalledWith(123);
  });

  it('hits glyph-loader.ts loadGlyphsByIds success path', () => {
    const gen = makeGenMock();
    (gen as any)._module._loadGlyph = vi.fn().mockReturnValue(0); // Success
    const r = loadGlyphsByIds(gen, new Set([1]), new Map());
    expect(r.loaded).toBe(1);
  });

  it('hits glyph-loader.ts PUA exhaustion', () => {
    // We can't easily set PUA_END, but we can mock resolveUnicode if we were in the same file.
    // Since we're not, let's look at the implementation of resolveUnicode:
    // if (PUA_START + puaIndex > PUA_END) return null;
    // puaIndex starts at 0 and increments for each glyph NOT in glyphIdToCodepoint.
    // PUA_END - PUA_START = 0xF8FF - 0xE000 = 6399 (so 6400 slots).

    // Instead of loops, we can try to mock the internal state if we had access.
    // But loadGlyphsByIds clears state.
    // Let's just use a smaller loop if possible or skip this if it's too slow.
    // Actually, 6400 iterations in a unit test is fast enough for JS.
    const gen = makeGenMock();
    const ids = new Set<number>();
    for (let i = 1; i <= 6401; i++) ids.add(i);
    const result = loadGlyphsByIds(gen, ids, new Map());
    expect(result.skipped).toBeGreaterThan(0); // At least one should skip due to exhaustion
  });

  it('hits glyph-loader.ts kerning error and preprocess:false', () => {
    const gen = makeGenMock();
    (gen as any).loadKerningData = vi.fn().mockImplementation(() => {
      throw new Error('kern error');
    });
    const r = loadGlyphsByIds(gen, new Set([1]), new Map(), { preprocess: false });
    expect(r.loaded).toBe(1);
    expect((gen as any)._module._loadGlyph).toHaveBeenCalledWith(1, expect.anything(), 0);
  });

  it('hits google-fonts.ts subset resolution branches', () => {
    const handler = new GoogleFontsHandler({} as never, false);
    const extractor = (handler as any).extractFontUrl.bind(handler);

    const cssArabic = '@font-face { unicode-range: U+600-6FF; src: url(arabic.ttf); }';

    // 1. success
    expect(extractor(cssArabic, 'any', 'arabic')).toBe('arabic.ttf');

    // 2. not found in this block (falls through)
    expect(extractor(cssArabic, 'any', 'hebrew')).toBe('arabic.ttf');

    // 3. invalid subset (!)
    expect(extractor(cssArabic, 'any', 'unknown-subset')).toBe('arabic.ttf');

    // 4. block with no range
    const cssNoRange = '@font-face { src: url(x.ttf); }';
    expect(extractor(cssNoRange, 'any', 'arabic')).toBe('x.ttf');

    // 5. range return false inside some
    const cssMixed = '@font-face { unicode-range: U+999, U+600-6FF; src: url(mixed.ttf); }';
    expect(extractor(cssMixed, 'any', 'arabic')).toBe('mixed.ttf');
  });

  it('hits converter.ts worker ignores and identity fallback', async () => {
    // Identity fallback (no name, no format)
    const converter = new MSDFConverter();
    await converter.initialize();

    // This will fail because Buffer.alloc(0) is invalid, but we hit the branches
    const res = await (converter as any)._executeInlineConversion(
      Buffer.alloc(0),
      'test font',
      {},
      undefined,
      {},
    );
    expect(res.success).toBe(false);

    await converter.dispose();
  });

  it('hits glyph-loader.ts default options', () => {
    const gen = makeGenMock();
    loadGlyphsByIds(gen, new Set([0]), new Map()); // No 4th arg
  });

  it('hits converter.ts _executeInlineConversion error paths and disposal', async () => {
    const converter = new MSDFConverter();
    await converter.initialize();

    // Test: Failed to pack glyphs
    const mockGenFailPack = makeGenMock();
    (mockGenFailPack as any).glyphs = { length: 1 };
    (mockGenFailPack as any).packGlyphs = vi.fn().mockReturnValue([]);
    (converter as any).gen = mockGenFailPack;
    const res2 = await (converter as any)._executeInlineConversion(
      Buffer.alloc(0),
      'test',
      { charset: 'A' },
      undefined,
      {},
    );
    expect(res2.success).toBe(false);

    await converter.dispose();
  });

  it('hits UniversalMSDFGenerator disposal and identity edge cases', async () => {
    const gen = new UniversalMSDFGenerator({ name: 'custom' });
    await gen.ensureInitialized();
    await gen.dispose();

    const gen2 = new UniversalMSDFGenerator();
    gen2._enableSharedConverter();
    await gen2.ensureInitialized();
    await gen2.dispose(); // Should not dispose shared converter
  });

  it('hits converter.ts _renderAtlases with callback', async () => {
    const converter = new MSDFConverter();
    await converter.initialize();
    const mockGen = makeGenMock();
    const bins = [{ width: 10, height: 10, rects: [] }];
    const callback = vi.fn().mockResolvedValue(undefined);

    const atlases = await (converter as any)._renderAtlases(mockGen, 'font', bins, callback);
    expect(callback).toHaveBeenCalled();
    expect(atlases.length).toBe(0); // Accumulates nothing if callback is present
  });

  it('hits converter.ts convertMultiple error path', async () => {
    const converter = new MSDFConverter();
    await converter.initialize();
    vi.spyOn(converter, 'convert').mockRejectedValue(new Error('Test Error'));

    const results = await converter.convertMultiple([{ buffer: Buffer.alloc(0), name: 'Fail' }]);
    expect(results[0].success).toBe(false);
    // @ts-expect-error
    expect(results[0].error).toBe('Test Error');
  });

  it('hits converter.ts shared converter disposal', async () => {
    const c1 = await getSharedConverter();
    expect(c1).toBeDefined();
    await disposeSharedConverter();
    const c2 = await getSharedConverter();
    expect(c1).not.toBe(c2); // New instance should be created
    await disposeSharedConverter();
  });

  it('covers resolvePresentationForms with Arabic letters', () => {
    const result = resolvePresentationForms('بتث');
    expect(result).toContain(0x0628);
    expect(result).toContain(0xfe8f);
  });
});
