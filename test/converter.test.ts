import generateBmFont from 'msdf-bmfont-xml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MSDFConverter from '../src/converter.js';

vi.mock('msdf-bmfont-xml', () => ({
  default: vi.fn(),
}));

describe('MSDFConverter', () => {
  let converter: MSDFConverter;
  const mockTextures = [{ filename: 'font.png', texture: Buffer.from('fake-png') }];
  const mockResult = {
    info: { face: 'Roboto' },
    common: { lineHeight: 64 },
    chars: [{ id: 65, char: 'A' }],
    kernings: [{ first: 65, second: 66, amount: -1 }],
  };

  beforeEach(() => {
    converter = new MSDFConverter();
    vi.clearAllMocks();
  });

  describe('Lifecycle', () => {
    it('should operate without error', async () => {
      await converter.initialize();
      await converter.dispose();
    });
  });

  describe('convert arity and branches', () => {
    it('should handle onProgress presence and absence', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) => {
        cb(null, mockTextures, JSON.stringify(mockResult));
      });
      const progress = vi.fn();
      await converter.convert(Buffer.from('f'), 'R', { onProgress: progress });
      await converter.convert(Buffer.from('f'), 'R', {});
    });

    it('should handle failures with and without prefixes', async () => {
      // No prefix
      (generateBmFont as any).mockImplementationOnce((_buf: Buffer, _cfg: any, cb: Function) =>
        cb(new Error('One')),
      );
      const r1 = await converter.convert(Buffer.from('f'), 'R');
      expect(r1.success).toBe(false);
      expect(r1.error).toContain('msdf-bmfont-xml failed: One');

      // Already prefixed
      (generateBmFont as any).mockImplementationOnce((_buf: Buffer, _cfg: any, cb: Function) =>
        cb('msdf-bmfont-xml failed: Two'),
      );
      const r2 = await converter.convert(Buffer.from('f'), 'R');
      expect(r2.success).toBe(false);
      expect(r2.error).toBe('msdf-bmfont-xml failed: Two');

      // Internal try-catch error
      (generateBmFont as any).mockImplementationOnce((_buf: Buffer, _cfg: any, cb: Function) =>
        cb(null, mockTextures, 'invalid'),
      );
      const r3 = await converter.convert(Buffer.from('f'), 'R');
      expect(r3.success).toBe(false);
    });
  });

  describe('convertMultiple arity', () => {
    it('should handle batch paths and errors', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) =>
        cb(null, mockTextures, JSON.stringify(mockResult)),
      );
      await converter.convertMultiple([{ buffer: Buffer.alloc(0), name: 'F1' }], {
        onProgress: vi.fn(),
      });

      vi.spyOn(converter, 'convert').mockRejectedValueOnce(new Error('fail-err'));
      await converter.convertMultiple([{ buffer: Buffer.alloc(0), name: 'T1' }]);

      vi.spyOn(converter, 'convert').mockRejectedValueOnce('fail-raw');
      await converter.convertMultiple([{ buffer: Buffer.alloc(0), name: 'T2' }]);
    });
  });

  describe('Internal Methods (Full Path Exhaustion)', () => {
    it('should exercise parseFontDescriptor branches', () => {
      expect((converter as any).parseFontDescriptor('{"f":"t"}')).toEqual({ f: 't' });
      const obj = { f: 'obj' };
      expect((converter as any).parseFontDescriptor(obj)).toBe(obj);
      expect((converter as any).parseFontDescriptor({ data: '{"f":"ds"}' })).toEqual({ f: 'ds' });
      expect((converter as any).parseFontDescriptor({ data: { f: 'do' } })).toEqual({ f: 'do' });
      expect(() => (converter as any).parseFontDescriptor(123)).toThrow();
      expect(() => (converter as any).parseFontDescriptor(null)).toThrow();

      expect(() => (converter as any).parseFontDescriptor('bad')).toThrow('unparseable');
    });

    it('should handle layout logic variants', async () => {
      // Multi-page atlas
      const mockKerns = {
        info: { face: 'A' },
        common: { lh: 1 },
        chars: [],
        kernings: [{ first: 1, second: 2, amount: 1 }],
      };
      (generateBmFont as any).mockImplementationOnce((_buf: Buffer, _cfg: any, cb: Function) =>
        cb(null, [mockTextures[0], mockTextures[0]], JSON.stringify(mockKerns)),
      );
      await converter.convert(Buffer.from('f'), 'R');

      // altKerning present
      const mockAlt = { kerning: [{ first: 1, second: 2, amount: 1 }] };
      (generateBmFont as any).mockImplementationOnce((_buf: Buffer, _cfg: any, cb: Function) =>
        cb(null, mockTextures, JSON.stringify(mockAlt)),
      );
      await converter.convert(Buffer.from('f'), 'R');

      // None present
      (generateBmFont as any).mockImplementationOnce((_buf: Buffer, _cfg: any, cb: Function) =>
        cb(null, mockTextures, '{}'),
      );
      await converter.convert(Buffer.from('f'), 'R');
    });

    it('should exercise charset length branches (array vs string)', async () => {
      (generateBmFont as any).mockImplementation((_buf: Buffer, _cfg: any, cb: Function) =>
        cb(null, mockTextures, JSON.stringify(mockResult)),
      );
      await converter.convert(Buffer.from('f'), 'R', { charset: ['A', 'B'] });
      await converter.convert(Buffer.from('f'), 'R', { charset: 'ABC' });
    });
  });
});
