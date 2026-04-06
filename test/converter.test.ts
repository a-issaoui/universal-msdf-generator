import generateBmFont from 'msdf-bmfont-xml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MSDFConverter from '../src/converter.js';

vi.mock('msdf-bmfont-xml', () => ({
  default: vi.fn(),
}));

describe('MSDFConverter', () => {
  let converter: MSDFConverter;

  beforeEach(() => {
    converter = new MSDFConverter();
    vi.clearAllMocks();
  });

  describe('initialize / dispose', () => {
    it('should initialize and dispose without errors', async () => {
      await expect(converter.initialize()).resolves.toBeUndefined();
      await expect(converter.dispose()).resolves.toBeUndefined();
    });
  });

  describe('convert', () => {
    const mockResult = { pages: [], chars: [], info: {}, common: {} };
    const mockTextures = [{ filename: 'test.png', texture: Buffer.from('fake-image') }];

    it('should successfully convert font buffer', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, mockResult);
      });

      const result = await converter.convert(Buffer.from('font'), 'TestFont');

      if (!result.success || result.cached) {
        throw new Error('Expected successful non-cached result');
      }

      expect(result.success).toBe(true);
      expect(result.fontName).toBe('TestFont');
      expect(result.data.pages[0]).toBe('TestFont.png');
      expect(result.atlases[0].filename).toBe('TestFont.png');
      expect(generateBmFont).toHaveBeenCalled();
    });

    it('should result in success: false if engine fails', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(new Error('Engine crash'));
      });

      const result = await converter.convert(Buffer.from('font'), 'FailFont');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('msdf-bmfont-xml failed: Engine crash');
      }
    });

    it('should work without onProgress callback', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, mockResult);
      });

      const result = await converter.convert(Buffer.from('font'), 'TestFont', {
        onProgress: undefined,
      });
      expect(result.success).toBe(true);
    });

    it('should respect fieldRange of 0', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, mockResult);
      });

      await converter.convert(Buffer.from('font'), 'TestFont', { fieldRange: 0 });
      expect(generateBmFont).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ distanceRange: 0 }),
        expect.anything(),
      );
    });

    it('should fall back to default fieldRange if provided as undefined', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, mockResult);
      });

      const converterWithDefault = new MSDFConverter({ fieldRange: 12 });
      await converterWithDefault.convert(Buffer.from('font'), 'TestFont', {
        fieldRange: undefined,
      });
      expect(generateBmFont).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ distanceRange: 12 }),
        expect.anything(),
      );
    });

    it('should fall back to 4 if both are undefined', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, mockResult);
      });

      const converterNoDefault = new MSDFConverter({ fieldRange: undefined } as any);
      await converterNoDefault.convert(Buffer.from('font'), 'TestFont', { fieldRange: undefined });
      expect(generateBmFont).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ distanceRange: 4 }),
        expect.anything(),
      );
    });

    it('should use default fontSize if provided as null', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, mockResult);
      });

      const result = await converter.convert(Buffer.from('font'), 'TestFont', {
        fontSize: null as any,
      });
      if (result.success && !result.cached) {
        expect(result.metadata.fontSize).toBe(48);
      }
    });

    it('should handle variations in msdf-bmfont-xml output (parsing string)', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, JSON.stringify(mockResult));
      });

      const result = await converter.convert(Buffer.from('font'), 'TestFont');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.info).toBeDefined();
      }
    });

    it('should handle non-Error catch in convert', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb('string-error');
      });

      const result = await converter.convert(Buffer.from('font'), 'TestFont');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('msdf-bmfont-xml failed: string-error');
      }
    });
  });

  describe('convertMultiple', () => {
    const mockResult = { pages: [], chars: [], info: {}, common: {} };
    const mockTextures = [{ filename: 'test.png', texture: Buffer.from('fake-image') }];

    it('should batch convert multiple fonts', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, mockResult);
      });

      const fonts = [
        { buffer: Buffer.from('font1'), name: 'Font1' },
        { buffer: Buffer.from('font2'), name: 'Font2' },
      ];

      const onProgress = vi.fn();
      const results = await converter.convertMultiple(fonts, { onProgress });

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(onProgress).toHaveBeenCalled();
    });

    it('should aggregate errors without throwing', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(new Error('Internal failure'));
      });

      const fonts = [{ buffer: Buffer.from('font'), name: 'FailFont' }];
      const results = await converter.convertMultiple(fonts);

      expect(results[0].success).toBe(false);
      if (!results[0].success) {
        expect(results[0].error).toContain('Internal failure');
      }
    });

    it('should handle non-object throw in convertMultiple', async () => {
      vi.spyOn(converter, 'convert').mockRejectedValueOnce('primitive-error');

      const fonts = [{ buffer: Buffer.from('font'), name: 'FailFont' }];
      const results = await converter.convertMultiple(fonts);

      expect(results[0].success).toBe(false);
      if (!results[0].success) {
        expect(results[0].error).toBe('primitive-error');
      }
    });
  });

  describe('helper methods', () => {
    it('should correctly parse JSON font descriptors', () => {
      const data = { info: { face: 'Test' } };
      const parsed = (converter as any).parseFontDescriptor(JSON.stringify(data));
      expect(parsed.info).toEqual(data.info);
    });

    it('should handle wrapped {data: string} descriptors', () => {
      const data = { info: { face: 'Test' } };
      const wrapped = { data: JSON.stringify(data) };
      const parsed = (converter as any).parseFontDescriptor(wrapped);
      expect(parsed.info).toEqual(data.info);
    });

    it('should handle direct object descriptors', () => {
      const data = { info: { face: 'Test' } };
      const parsed = (converter as any).parseFontDescriptor(data);
      expect(parsed.info).toEqual(data.info);
    });

    it('should throw on unsupported descriptor format', () => {
      expect(() => (converter as any).parseFontDescriptor(123)).toThrow(
        'Unsupported font descriptor format',
      );
    });

    it('should throw on unparseable JSON', () => {
      expect(() => (converter as any).parseFontDescriptor('{ invalid }')).toThrow(
        'unparseable font descriptor',
      );
    });

    it('should build layout with distanceField', () => {
      const fontObj = { info: {}, common: {}, chars: [] };
      const textures = [{ filename: 't.png', texture: Buffer.alloc(0) }];
      const layout = (converter as any).buildLayout(fontObj, textures, 'Test', 4);
      expect(layout.distanceField.distanceRange).toBe(4);
      expect(layout.pages).toContain('Test.png');
    });

    it('should build metadata correctly', () => {
      const meta = (converter as any).buildMetadata('abc', 48, [1024, 1024], 1, 4);
      expect(meta.charset).toBe(3);
      expect(meta.fontSize).toBe(48);
      expect(meta.engine).toBe('msdf-bmfont-xml');
    });

    it('should handle array charset in buildMetadata', () => {
      const meta = (converter as any).buildMetadata(['a', 'b', 'c'], 48, [1024, 1024], 1, 4);
      expect(meta.charset).toBe(3);
    });
  });
});
