import { beforeEach, describe, expect, it, vi } from 'vitest';
import MSDFConverter from '../src/converter.js';

// ── Mock msdfgen-wasm ────────────────────────────────────────────────────────
// vi.mock is hoisted — the factory cannot reference top-level variables.

vi.mock('msdfgen-wasm', () => ({
  // biome-ignore lint/style/useNamingConvention: msdfgen-wasm module export name
  Msdfgen: { create: vi.fn() },
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue(Buffer.alloc(64)),
  promises: { readFile: vi.fn(), stat: vi.fn() },
}));

vi.mock('node:module', () => ({
  createRequire: vi.fn().mockReturnValue({
    resolve: vi.fn().mockReturnValue('/fake/msdfgen.wasm'),
  }),
}));

// ── Factory helpers ────────────────────────────────────────────────────────

function makeGlyph(unicode = 65, kerning: [{ unicode: number }, number][] = []) {
  return {
    unicode,
    index: unicode - 29,
    advance: 0.6,
    left: 0.05,
    bottom: 0.0,
    right: 0.65,
    top: 0.7,
    kerning,
  };
}

function makeMsdfData(fontSize = 48, fieldRange = 4) {
  return {
    scale: fontSize,
    range: fieldRange / fontSize,
    width: 32,
    height: 36,
    xTranslate: 0,
    yTranslate: 0,
    edgeColoring: 'simple' as const,
    edgeThresholdAngle: 3,
    scanline: false,
  };
}

function makeRect(glyph = makeGlyph(), opts?: { width?: number; height?: number }) {
  return {
    x: 2,
    y: 2,
    width: opts?.width ?? 32,
    height: opts?.height ?? 36,
    rot: false,
    oversized: false,
    glyph,
    msdfData: makeMsdfData(),
  };
}

function makeBin(rects = [makeRect()]) {
  return { width: 512, height: 256, rects };
}

function makeMetrics() {
  return {
    emSize: 1,
    ascenderY: 0.8,
    descenderY: -0.2,
    lineHeight: 1.15,
    underlineY: -0.1,
    underlineThickness: 0.05,
    spaceAdvance: 0.25,
    tabAdvance: 1.0,
  };
}

function makeGenInstance(
  overrides?: Partial<{
    packGlyphs: ReturnType<typeof vi.fn>;
    createAtlasImage: ReturnType<typeof vi.fn>;
    loadFont: ReturnType<typeof vi.fn>;
  }>,
) {
  return {
    loadFont: overrides?.loadFont ?? vi.fn(),
    loadGlyphs: vi.fn(),
    packGlyphs: overrides?.packGlyphs ?? vi.fn().mockReturnValue([makeBin()]),
    createAtlasImage:
      overrides?.createAtlasImage ?? vi.fn().mockReturnValue(new Uint8Array(512 * 256 * 4)),
    get metrics() {
      return makeMetrics();
    },
  };
}

function makeBuf() {
  return Buffer.from('FAKE_FONT_DATA');
}

// ── Shared state set in beforeEach ─────────────────────────────────────────

let mockGen: ReturnType<typeof makeGenInstance>;
let MsdfgenMock: { create: ReturnType<typeof vi.fn> };

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MSDFConverter', () => {
  let converter: MSDFConverter;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { Msdfgen } = await import('msdfgen-wasm');
    MsdfgenMock = Msdfgen as unknown as { create: ReturnType<typeof vi.fn> };
    mockGen = makeGenInstance();
    MsdfgenMock.create.mockResolvedValue(mockGen);
    converter = new MSDFConverter();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    it('initializes and disposes without error', async () => {
      await converter.initialize();
      await converter.dispose();
    });

    it('concurrent initialize calls use a single Msdfgen.create call', async () => {
      await Promise.all([converter.initialize(), converter.initialize(), converter.initialize()]);
      expect(MsdfgenMock.create).toHaveBeenCalledTimes(1);
    });

    it('dispose resets state — next call to initialize re-creates gen', async () => {
      await converter.initialize();
      await converter.dispose();
      await converter.initialize();
      expect(MsdfgenMock.create).toHaveBeenCalledTimes(2);
    });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('convert: happy path', () => {
    it('returns MSDFSuccess with correct layout fields', async () => {
      const result = await converter.convert(makeBuf(), 'TestFont', {
        fontSize: 48,
        fieldRange: 4,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.fontName).toBe('TestFont');
      expect(result.atlases).toHaveLength(1);
      expect(result.atlases[0].filename).toBe('TestFont.png');
      expect(result.data.chars).toHaveLength(1);
      expect(result.data.chars[0].id).toBe(65);
      expect(result.data.chars[0].char).toBe('A');
      expect(result.data.chars[0].page).toBe(0);
      expect(result.data.common.scaleW).toBe(512);
      expect(result.data.common.scaleH).toBe(256);
      expect(result.data.common.pages).toBe(1);
      expect(result.data.distanceField.fieldType).toBe('msdf');
      expect(result.data.distanceField.distanceRange).toBe(4);
      expect(result.data.distanceField.type).toBe('msdf');
      expect(result.data.distanceField.range).toBe(4);
      expect(result.metadata.engine).toBe('msdfgen-wasm');
      expect(result.metadata.fontSize).toBe(48);
      expect(result.metadata.fieldRange).toBe(4);
    });

    it('single atlas: no page index in filename', async () => {
      const r = await converter.convert(makeBuf(), 'MyFont');
      if (!r.success) throw new Error(r.error);
      expect(r.atlases[0].filename).toBe('MyFont.png');
    });

    it('zero-size glyphs produce xoffset=0 and yoffset=0', async () => {
      mockGen = makeGenInstance({
        packGlyphs: vi
          .fn()
          .mockReturnValue([makeBin([makeRect(makeGlyph(), { width: 0, height: 0 })])]),
      });
      MsdfgenMock.create.mockResolvedValue(mockGen);
      converter = new MSDFConverter();
      const r = await converter.convert(makeBuf(), 'F');
      if (!r.success) throw new Error(r.error);
      expect(r.data.chars[0].xoffset).toBe(0);
      expect(r.data.chars[0].yoffset).toBe(0);
    });
  });

  // ── onProgress ─────────────────────────────────────────────────────────────

  describe('convert: onProgress', () => {
    it('fires 0% at start and 100% at end when callback provided', async () => {
      const progress = vi.fn();
      await converter.convert(makeBuf(), 'F', { onProgress: progress });
      expect(progress).toHaveBeenCalledWith(0, 0, 1);
      expect(progress).toHaveBeenCalledWith(100, 1, 1);
    });

    it('does not throw when onProgress is not provided', async () => {
      await expect(converter.convert(makeBuf(), 'F', {})).resolves.toBeDefined();
    });
  });

  // ── Option merging (??): falsy values are respected ───────────────────────

  describe('?? option merging', () => {
    it('respects fontSize: 0 — does not fall back to default 48', async () => {
      await converter.convert(makeBuf(), 'F', { fontSize: 0 });
      expect(mockGen.packGlyphs).toHaveBeenCalledWith(
        expect.objectContaining({ size: 0 }),
        expect.any(Object),
      );
    });

    it('charset: "" resolves via resolveCharset to alphanumeric (not empty)', async () => {
      // resolveCharset('') returns alphanumeric — this is the intended fallback
      const r = await converter.convert(makeBuf(), 'F', { charset: '' });
      expect(r.success).toBe(true);
      if (!r.success) return;
      // loadGlyphs is called because resolveCharset('') → alphanumeric → 62 codepoints
      expect(mockGen.loadGlyphs).toHaveBeenCalled();
    });

    it('charset: [] (empty array) produces zero codepoints — skips loadGlyphs/packGlyphs', async () => {
      // resolveCharset([]) → [].join('') = '' → empty codepoints array
      const r = await converter.convert(makeBuf(), 'F', { charset: [] });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.chars).toHaveLength(0);
      expect(r.atlases).toHaveLength(0);
      expect(mockGen.loadGlyphs).not.toHaveBeenCalled();
      expect(mockGen.packGlyphs).not.toHaveBeenCalled();
    });
  });

  // ── fixOverlaps ────────────────────────────────────────────────────────────

  describe('convert: fixOverlaps', () => {
    it('defaults to preprocess: true when fixOverlaps is not set', async () => {
      await converter.convert(makeBuf(), 'F');
      expect(mockGen.loadGlyphs).toHaveBeenCalledWith(expect.any(Array), { preprocess: true });
    });

    it('passes preprocess: false when fixOverlaps is false', async () => {
      await converter.convert(makeBuf(), 'F', { fixOverlaps: false });
      expect(mockGen.loadGlyphs).toHaveBeenCalledWith(expect.any(Array), { preprocess: false });
    });

    it('inherits fixOverlaps: false from constructor options', async () => {
      const c = new MSDFConverter({ fixOverlaps: false });
      MsdfgenMock.create.mockResolvedValue(mockGen);
      await c.convert(makeBuf(), 'F');
      expect(mockGen.loadGlyphs).toHaveBeenCalledWith(expect.any(Array), { preprocess: false });
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe('convert: error handling', () => {
    it('returns MSDFFailure when loadFont throws', async () => {
      mockGen.loadFont.mockImplementationOnce(() => {
        throw new Error('invalid font data');
      });
      const r = await converter.convert(makeBuf(), 'BadFont');
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error).toContain('msdfgen-wasm failed:');
      expect(r.error).toContain('invalid font data');
    });

    it('returns MSDFFailure when packGlyphs throws', async () => {
      mockGen.packGlyphs.mockImplementationOnce(() => {
        throw new Error('pack error');
      });
      const r = await converter.convert(makeBuf(), 'F');
      expect(r.success).toBe(false);
    });

    it('wraps non-Error throws in MSDFFailure', async () => {
      mockGen.loadFont.mockImplementationOnce(() => {
        throw 'raw string error'; // eslint-disable-line no-throw-literal
      });
      const r = await converter.convert(makeBuf(), 'F');
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error).toContain('raw string error');
    });
  });

  // ── Timeout ────────────────────────────────────────────────────────────────

  describe('convert: timeout', () => {
    it('rejects with timeout error when Msdfgen.create hangs', async () => {
      vi.useFakeTimers();
      MsdfgenMock.create.mockImplementation(() => new Promise(() => {})); // never resolves

      const hangConverter = new MSDFConverter();
      const promise = hangConverter.convert(makeBuf(), 'hang-test', {
        generationTimeout: 1000,
      });

      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow('msdfgen-wasm timed out after 1000ms for "hang-test"');
      vi.useRealTimers();
    });
  });

  // ── Multi-atlas ────────────────────────────────────────────────────────────

  describe('convert: multi-atlas', () => {
    it('generates indexed filenames when packGlyphs returns multiple bins', async () => {
      const bin2 = { width: 256, height: 256, rects: [] };
      mockGen = makeGenInstance({
        packGlyphs: vi.fn().mockReturnValue([makeBin(), bin2]),
      });
      MsdfgenMock.create.mockResolvedValue(mockGen);
      converter = new MSDFConverter();

      const r = await converter.convert(makeBuf(), 'Multi');
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.atlases[0].filename).toBe('Multi-0.png');
      expect(r.atlases[1].filename).toBe('Multi-1.png');
      expect(r.data.pages).toEqual(['Multi-0.png', 'Multi-1.png']);
      expect(r.metadata.atlasCount).toBe(2);
    });
  });

  // ── Kerning ────────────────────────────────────────────────────────────────

  describe('convert: kerning', () => {
    it('includes kerning pairs from glyph.kerning', async () => {
      const glyphB = makeGlyph(66);
      const glyphWithKern = makeGlyph(65, [[glyphB, -0.05]]);
      mockGen = makeGenInstance({
        packGlyphs: vi.fn().mockReturnValue([makeBin([makeRect(glyphWithKern)])]),
      });
      MsdfgenMock.create.mockResolvedValue(mockGen);
      converter = new MSDFConverter();

      const r = await converter.convert(makeBuf(), 'K', { fontSize: 48 });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.kernings).toHaveLength(1);
      expect(r.data.kernings[0].first).toBe(65);
      expect(r.data.kernings[0].second).toBe(66);
    });
  });

  // ── Charset variants ───────────────────────────────────────────────────────

  describe('convert: charset variants', () => {
    it('handles array charset', async () => {
      const r = await converter.convert(makeBuf(), 'F', { charset: ['A', 'B', 'C'] });
      expect(r.success).toBe(true);
    });

    it('handles preset charset name (alphanumeric)', async () => {
      const r = await converter.convert(makeBuf(), 'F', { charset: 'alphanumeric' });
      expect(r.success).toBe(true);
    });

    it('textureSize: null (both instance and call) falls back to 2048×2048 default', async () => {
      // Both the constructor option AND the per-call option must be null/undefined
      // for the ?? [2048, 2048] fallback to apply.
      const nullSizeConverter = new MSDFConverter({ textureSize: null });
      const r = await nullSizeConverter.convert(makeBuf(), 'F');
      expect(r.success).toBe(true);
      expect(mockGen.packGlyphs).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ maxWidth: 2048, maxHeight: 2048 }),
      );
    });
  });

  // ── edgeColoring + padding ─────────────────────────────────────────────────

  describe('convert: edgeColoring and padding', () => {
    it('passes edgeColoring to packGlyphs msdf options', async () => {
      await converter.convert(makeBuf(), 'F', { edgeColoring: 'inktrap' });
      expect(mockGen.packGlyphs).toHaveBeenCalledWith(
        expect.objectContaining({ edgeColoring: 'inktrap' }),
        expect.any(Object),
      );
    });

    it('defaults edgeColoring to "simple" when not specified', async () => {
      await converter.convert(makeBuf(), 'F');
      expect(mockGen.packGlyphs).toHaveBeenCalledWith(
        expect.objectContaining({ edgeColoring: 'simple' }),
        expect.any(Object),
      );
    });

    it('passes padding to packGlyphs atlas options', async () => {
      await converter.convert(makeBuf(), 'F', { padding: 8 });
      expect(mockGen.packGlyphs).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ padding: 8 }),
      );
    });

    it('defaults padding to 2 when not specified', async () => {
      await converter.convert(makeBuf(), 'F');
      expect(mockGen.packGlyphs).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ padding: 2 }),
      );
    });

    it('inherits edgeColoring and padding from constructor options', async () => {
      const c = new MSDFConverter({ edgeColoring: 'distance', padding: 4 });
      MsdfgenMock.create.mockResolvedValue(mockGen);
      await c.convert(makeBuf(), 'F');
      expect(mockGen.packGlyphs).toHaveBeenCalledWith(
        expect.objectContaining({ edgeColoring: 'distance' }),
        expect.objectContaining({ padding: 4 }),
      );
    });

    it('per-call edgeColoring overrides constructor default', async () => {
      const c = new MSDFConverter({ edgeColoring: 'distance' });
      MsdfgenMock.create.mockResolvedValue(mockGen);
      await c.convert(makeBuf(), 'F', { edgeColoring: 'inktrap' });
      expect(mockGen.packGlyphs).toHaveBeenCalledWith(
        expect.objectContaining({ edgeColoring: 'inktrap' }),
        expect.any(Object),
      );
    });
  });

  // ── convertMultiple ────────────────────────────────────────────────────────

  describe('convertMultiple', () => {
    it('processes a batch of fonts and returns results for all', async () => {
      const results = await converter.convertMultiple(
        [
          { buffer: makeBuf(), name: 'Font1' },
          { buffer: makeBuf(), name: 'Font2' },
        ],
        { onProgress: vi.fn() },
      );
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('continues after a font fails mid-batch', async () => {
      vi.spyOn(converter, 'convert')
        .mockResolvedValueOnce({
          success: true,
          fontName: 'F1',
          data: {} as never,
          atlases: [],
          metadata: {} as never,
        })
        .mockRejectedValueOnce(new Error('batch-fail'));

      const results = await converter.convertMultiple([
        { buffer: makeBuf(), name: 'F1' },
        { buffer: makeBuf(), name: 'F2' },
      ]);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      if (!results[1].success) expect(results[1].error).toContain('batch-fail');
    });

    it('wraps non-Error batch throws in MSDFFailure', async () => {
      vi.spyOn(converter, 'convert').mockRejectedValueOnce('raw-fail');
      const results = await converter.convertMultiple([{ buffer: makeBuf(), name: 'F' }]);
      expect(results[0].success).toBe(false);
      if (!results[0].success) expect(results[0].error).toContain('raw-fail');
    });
  });
});
