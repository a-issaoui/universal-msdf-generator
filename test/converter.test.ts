import generateBmFont from 'msdf-bmfont-xml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      vi.mocked(generateBmFont).mockImplementation((_buf, _cfg, cb) => {
        cb(null, mockTextures, JSON.stringify(mockResult));
      });
      const progress = vi.fn();
      await converter.convert(Buffer.from('f'), 'R', { onProgress: progress });
      expect(progress).toHaveBeenCalledWith(0, 0, 1);
      expect(progress).toHaveBeenCalledWith(100, 1, 1);
      await converter.convert(Buffer.from('f'), 'R', {});
    });

    it('should handle failures with and without prefixes', async () => {
      // No prefix
      vi.mocked(generateBmFont).mockImplementationOnce((_buf, _cfg, cb) =>
        cb(new Error('One'), [], null),
      );
      const r1 = await converter.convert(Buffer.from('f'), 'R');
      expect(r1.success).toBe(false);
      if (!r1.success) expect(r1.error).toContain('msdf-bmfont-xml failed: One');

      // Already prefixed
      vi.mocked(generateBmFont).mockImplementationOnce((_buf, _cfg, cb) =>
        cb(new Error('msdf-bmfont-xml failed: Two'), [], null),
      );
      const r2 = await converter.convert(Buffer.from('f'), 'R');
      expect(r2.success).toBe(false);
      if (!r2.success) expect(r2.error).toBe('msdf-bmfont-xml failed: Two');

      // Internal try-catch error
      vi.mocked(generateBmFont).mockImplementationOnce((_buf, _cfg, cb) =>
        cb(null, mockTextures, 'invalid'),
      );
      const r3 = await converter.convert(Buffer.from('f'), 'R');
      expect(r3.success).toBe(false);
    });

    it('should reject with timeout error when callback never fires', async () => {
      vi.useFakeTimers();
      // Mock that never calls back
      vi.mocked(generateBmFont).mockImplementation(() => {
        // intentionally empty — never calls cb
      });

      const promise = converter.convert(Buffer.from('f'), 'hang-test', { generationTimeout: 1000 });
      // Advance time past the timeout threshold
      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow(
        'msdf-bmfont-xml timed out after 1000ms for "hang-test"',
      );
      vi.useRealTimers();
    });
  });

  describe('?? option merging', () => {
    it('should respect fontSize: 0 (not fall back to default 48)', async () => {
      let capturedConfig: Record<string, unknown> = {};
      vi.mocked(generateBmFont).mockImplementation((_buf, cfg, cb) => {
        capturedConfig = cfg as Record<string, unknown>;
        cb(null, mockTextures, JSON.stringify(mockResult));
      });
      await converter.convert(Buffer.from('f'), 'R', { fontSize: 0 });
      expect(capturedConfig.fontSize).toBe(0);
    });

    it('should respect charset: "" (not fall back to default alphanumeric)', async () => {
      let capturedConfig: Record<string, unknown> = {};
      vi.mocked(generateBmFont).mockImplementation((_buf, cfg, cb) => {
        capturedConfig = cfg as Record<string, unknown>;
        cb(null, mockTextures, JSON.stringify(mockResult));
      });
      await converter.convert(Buffer.from('f'), 'R', { charset: '' });
      expect(capturedConfig.charset).toBe('');
    });
  });

  describe('convertMultiple arity', () => {
    it('should handle batch paths and errors', async () => {
      vi.mocked(generateBmFont).mockImplementation((_buf, _cfg, cb) =>
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
      type ConverterInternals = { parseFontDescriptor(x: unknown): unknown };
      const c = converter as unknown as ConverterInternals;
      expect(c.parseFontDescriptor('{"f":"t"}')).toEqual({ f: 't' });
      const obj = { f: 'obj' };
      expect(c.parseFontDescriptor(obj)).toBe(obj);
      expect(c.parseFontDescriptor({ data: '{"f":"ds"}' })).toEqual({ f: 'ds' });
      expect(c.parseFontDescriptor({ data: { f: 'do' } })).toEqual({ f: 'do' });
      expect(() => c.parseFontDescriptor(123)).toThrow();
      expect(() => c.parseFontDescriptor(null)).toThrow();
      expect(() => c.parseFontDescriptor('bad')).toThrow('unparseable');
    });

    it('should handle layout logic variants', async () => {
      afterEach(() => vi.useRealTimers());
      // Multi-page atlas
      const mockKerns = {
        info: { face: 'A' },
        common: { lh: 1 },
        chars: [],
        kernings: [{ first: 1, second: 2, amount: 1 }],
      };
      vi.mocked(generateBmFont).mockImplementationOnce((_buf, _cfg, cb) =>
        cb(null, [mockTextures[0], mockTextures[0]], JSON.stringify(mockKerns)),
      );
      await converter.convert(Buffer.from('f'), 'R');

      // altKerning present
      const mockAlt = { kerning: [{ first: 1, second: 2, amount: 1 }] };
      vi.mocked(generateBmFont).mockImplementationOnce((_buf, _cfg, cb) =>
        cb(null, mockTextures, JSON.stringify(mockAlt)),
      );
      await converter.convert(Buffer.from('f'), 'R');

      // None present
      vi.mocked(generateBmFont).mockImplementationOnce((_buf, _cfg, cb) =>
        cb(null, mockTextures, '{}'),
      );
      await converter.convert(Buffer.from('f'), 'R');
    });

    it('should exercise charset length branches (array vs string)', async () => {
      vi.mocked(generateBmFont).mockImplementation((_buf, _cfg, cb) =>
        cb(null, mockTextures, JSON.stringify(mockResult)),
      );
      await converter.convert(Buffer.from('f'), 'R', { charset: ['A', 'B'] });
      await converter.convert(Buffer.from('f'), 'R', { charset: 'ABC' });
    });
  });
});
