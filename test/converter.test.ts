// @ts-expect-error
import generateBmFont from 'msdf-bmfont-xml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MSDFConverter from '../src/converter.js';

vi.mock('msdf-bmfont-xml', () => ({
  default: vi.fn(),
}));

describe('MSDFConverter', () => {
  let converter: MSDFConverter;
  const mockTextures = [{ filename: 'test.png', texture: Buffer.alloc(0) }];
  const mockResult = {
    info: { face: 'Roboto' },
    common: { lineHeight: 50 },
    chars: [],
    kernings: [],
  };

  beforeEach(async () => {
    converter = new MSDFConverter();
    await converter.initialize();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should use provided options', () => {
      const custom = new MSDFConverter({ fontSize: 24, fieldRange: 2 });
      expect((custom as any).options.fontSize).toBe(24);
      expect((custom as any).options.fieldRange).toBe(2);
    });

    it('should use default options if none provided', () => {
      const def = new MSDFConverter();
      expect((def as any).options.fontSize).toBe(48);
    });
  });

  describe('convert', () => {
    it('should call generateBmFont with correct config', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, JSON.stringify(mockResult));
      });

      const result = await converter.convert(Buffer.from('font'), 'TestFont', {
        charset: 'abc',
        fontSize: 32,
        textureSize: [256, 256],
        fieldRange: 3,
      });

      expect(result.success).toBe(true);
      expect(result.fontName).toBe('TestFont');
      if (result.success) {
        expect(result.atlases).toHaveLength(1);
        expect(result.data.info.face).toBe('Roboto');
        expect(result.metadata.fontSize).toBe(32);
        expect(result.metadata.fieldRange).toBe(3);
      }
    });

    it('should use instance defaults for missing call options', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, JSON.stringify(mockResult));
      });

      const result = await converter.convert(Buffer.from('font'), 'TestFont');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.metadata.fontSize).toBe(48);
      }
    });

    it('should handle msdf-bmfont-xml errors', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(new Error('Internal breakdown'));
      });

      const result = await converter.convert(Buffer.from('font'), 'FailFont');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Internal breakdown');
      }
    });

    it('should handle non-Error failures from msdf-bmfont-xml', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb('string-error');
      });

      const result = await converter.convert(Buffer.from('font'), 'TestFont');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('msdf-bmfont-xml failed: string-error');
      }
    });

    it('should handle unexpected errors during layout building', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, [], '{ invalid json }');
      });

      const result = await converter.convert(Buffer.from('font'), 'FailFont');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('unparseable font descriptor');
      }
    });

    it('should handle non-Error catch in build phase', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, [], '{}');
      });
      // @ts-expect-error
      vi.spyOn(converter, 'buildLayout' as any).mockImplementationOnce(() => {
        throw 'raw-build-fail';
      });
      const result = await converter.convert(Buffer.from('font'), 'FailFont');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('raw-build-fail');
      }
    });
  });

  describe('convertMultiple', () => {
    it('should batch convert multiple fonts', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, JSON.stringify(mockResult));
      });

      const fonts = [{ buffer: Buffer.from('font1'), name: 'Font1' }];

      const results = await converter.convertMultiple(fonts);
      expect(results).toHaveLength(1);
    });

    it('should handle both Error and non-Error failures in convertMultiple catch block', async () => {
      // Hit non-Error branch
      // @ts-expect-error
      vi.spyOn(converter, 'convert').mockRejectedValueOnce('raw-fail');
      let results = await converter.convertMultiple([{ buffer: Buffer.alloc(10), name: 'Test' }]);
      expect(results[0].error).toBe('raw-fail');

      // Hit Error branch
      // @ts-expect-error
      vi.spyOn(converter, 'convert').mockRejectedValueOnce(new Error('real-error'));
      results = await converter.convertMultiple([{ buffer: Buffer.alloc(10), name: 'Test' }]);
      expect(results[0].error).toBe('real-error');
    });
  });

  describe('Internal Methods (Branch Coverage)', () => {
    it('should use deep defaults for info/common if missing from descriptor', () => {
      const mockDescriptor = {};
      // @ts-expect-error
      const layout = converter.buildLayout(mockDescriptor, [], 'Test', 4);
      expect(layout.info).toEqual({});
      expect(layout.common).toEqual({});
      expect(layout.chars).toEqual([]);
      expect(layout.kernings).toEqual([]);
    });

    it('should handle kerning vs kernings key', () => {
      // @ts-expect-error
      const layout = converter.buildLayout({ kernings: [1] }, [], 'T', 4);
      expect(layout.kernings).toHaveLength(1);
      // @ts-expect-error
      const layout2 = converter.buildLayout({ kerning: [2] }, [], 'T', 4);
      expect(layout2.kernings).toHaveLength(1);
    });

    it('should cover resolve path with non-Error in construct', () => {
      try {
        // @ts-expect-error
        converter.parseFontDescriptor({ data: 123 });
      } catch (e) {}
    });

    it('should handle multi-page filenames and array charsets in metadata', async () => {
      const multiTextures = [
        { filename: 'a.png', texture: Buffer.alloc(0) },
        { filename: 'b.png', texture: Buffer.alloc(0) },
      ];
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, multiTextures, '{}');
      });
      const result = await converter.convert(Buffer.alloc(10), 'Multi', { charset: ['a'] });
      if (result.success) {
        expect(result.atlases).toHaveLength(2);
        expect(result.metadata.charset).toBe(1);
      }
    });

    it('should handle direct object in descriptor without data key via convert', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, { info: { face: 'Direct' } });
      });
      const result = await converter.convert(Buffer.from('font'), 'DirectTest');
      expect(result.success).toBe(true);
    });

    it('should throw Unsupported font descriptor format for non-objects', () => {
      // @ts-expect-error
      expect(() => converter.parseFontDescriptor(123)).toThrow(
        'Unsupported font descriptor format',
      );
    });

    it('should use metadata fallbacks', () => {
      // @ts-expect-error
      const meta = converter.buildMetadata('abc', undefined, null, 1, 4);
      expect(meta.fontSize).toBe(48);
      expect(meta.textureSize).toEqual([1024, 1024]);
    });

    it('should cover all option fallbacks in convert', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, [], '{}');
      });
      // @ts-expect-error
      const conv = new MSDFConverter({ fieldRange: undefined, textureSize: undefined });
      await conv.convert(Buffer.alloc(10), 'Test', {
        fieldRange: undefined,
        textureSize: undefined,
      });
    });

    it('should handle array charset in config', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, cfg: any, cb: Function) => {
        expect(cfg.charset).toBe('abc');
        cb(null, [], '{}');
      });
      await converter.convert(Buffer.alloc(10), 'Test', { charset: ['a', 'b', 'c'] });
    });
  });
});
