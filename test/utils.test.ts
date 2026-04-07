import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MSDFCachedSuccess,
  MSDFFailure,
  MSDFLayout,
  MSDFSuccess,
  OutputFormat,
} from '../src/types.js';
import MSDFUtils from '../src/utils.js';

vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('{"version":"1.0","atlasCount":1}'),
  },
}));

describe('MSDFUtils', () => {
  describe('Charsets', () => {
    it('should provide common charsets', () => {
      const charsets = MSDFUtils.getCharsets();
      expect(charsets.ascii).toBeDefined();
      expect(charsets.alphanumeric).toBeDefined();
      expect(charsets.latin).toBeDefined();
      expect(charsets.cyrillic).toBeDefined();
      expect(typeof charsets.custom).toBe('function');
    });

    it('should generate ASCII charset', () => {
      const ascii = MSDFUtils.getASCIICharset();
      expect(ascii).toHaveLength(95); // 32 to 126
      expect(ascii).toContain(' ');
      expect(ascii).toContain('~');
    });

    it('should generate Alphanumeric charset', () => {
      const alphanumeric = MSDFUtils.getAlphanumericCharset();
      expect(alphanumeric).toContain('A');
      expect(alphanumeric).toContain('z');
      expect(alphanumeric).toContain('0');
      expect(alphanumeric).not.toContain('!');
    });

    it('should generate Latin charset', () => {
      const latin = MSDFUtils.getLatinCharset();
      expect(latin).toContain('À');
      expect(latin).toContain('ÿ');
    });

    it('should generate Cyrillic charset', () => {
      const cyrillic = MSDFUtils.getCyrillicCharset();
      expect(cyrillic).toContain('А');
      expect(cyrillic).toContain('я');
    });

    it('should support custom charset provider', () => {
      const charsets = MSDFUtils.getCharsets();
      const custom = charsets.custom as (chars: string) => string[];
      expect(custom('abc')).toEqual(['a', 'b', 'c']);
    });

    it('should resolve charsets correctly', () => {
      const resolve = MSDFUtils.resolveCharset;
      expect(resolve(undefined)).toBe(MSDFUtils.getLatinCharset());
      expect(resolve('latin')).toBe(MSDFUtils.getLatinCharset());
      expect(resolve('alphanumeric')).toBe(MSDFUtils.getAlphanumericCharset());
      expect(resolve('cyrillic')).toBe(MSDFUtils.getCyrillicCharset());
      expect(resolve(['a', 'b'])).toBe('ab');
      expect(resolve([65, 66, 'C'])).toBe('ABC');
      expect(resolve('ascii')).toBe(MSDFUtils.getASCIICharset());
      expect(resolve('custom-raw')).toBe('custom-raw');
      expect(() => resolve('custom')).toThrow(
        '"custom" is a custom charset provider, not a preset name.',
      );
    });

    it('should handle Set charsets', () => {
      const resolve = MSDFUtils.resolveCharset;
      expect(resolve(new Set(['a', 'b']))).toBe('ab');
      expect(resolve(new Set([65, 66, 'C']))).toBe('ABC');
    });

    it('should fallback to string coercion for numbers', () => {
      expect(MSDFUtils.resolveCharset(1234 as unknown as Set<string>)).toBe('1234');
    });
  });

  describe('calculateOptimalTextureSize', () => {
    it('should calculate power-of-two sizes', () => {
      const [w, h] = MSDFUtils.calculateOptimalTextureSize(100, 48);
      expect(w).toBe(h);
      expect(Math.log2(w) % 1).toBe(0);
    });

    it('should cap size at 4096', () => {
      const [w, h] = MSDFUtils.calculateOptimalTextureSize(10000, 200);
      expect(w).toBeLessThanOrEqual(4096);
      expect(h).toBeLessThanOrEqual(4096);
    });

    it('should handle small character counts', () => {
      const [w, h] = MSDFUtils.calculateOptimalTextureSize(1, 48);
      expect(w).toBe(512);
      expect(h).toBe(512);
    });

    it('should handle moderate character counts', () => {
      const [w, h] = MSDFUtils.calculateOptimalTextureSize(1000, 48);
      expect(w).toBe(2048);
      expect(h).toBe(2048);
    });
  });

  describe('validateFontBuffer', () => {
    it('should reject empty or null buffer', () => {
      expect(MSDFUtils.validateFontBuffer(Buffer.alloc(0))).toBe(false);
      expect(MSDFUtils.validateFontBuffer(null as unknown as Buffer)).toBe(false);
    });

    it('should reject invalid signature', () => {
      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(MSDFUtils.validateFontBuffer(invalidBuffer)).toBe(false);
    });

    it('should validate valid signatures', () => {
      const ttf = Buffer.from([0x00, 0x01, 0x00, 0x00]);
      const otf = Buffer.from('OTTO');
      const woff = Buffer.from('wOFF');
      const woff2 = Buffer.from('wOF2');

      expect(MSDFUtils.validateFontBuffer(ttf)).toBe(true);
      expect(MSDFUtils.validateFontBuffer(otf)).toBe(true);
      expect(MSDFUtils.validateFontBuffer(woff)).toBe(true);
      expect(MSDFUtils.validateFontBuffer(woff2)).toBe(true);
    });
  });

  describe('saveMSDFOutput', () => {
    const mockResult: MSDFSuccess = {
      success: true,
      fontName: 'TestFont',
      data: { pages: [], chars: [], info: {}, common: {} } as unknown as MSDFLayout,
      metadata: {} as unknown as MSDFSuccess['metadata'],
      atlases: [],
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should create directory and save JSON', async () => {
      const paths = await MSDFUtils.saveMSDFOutput(mockResult, './out', { format: 'json' });
      const resolvedOut = path.resolve('./out');
      expect(fs.mkdir).toHaveBeenCalledWith(resolvedOut, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join(resolvedOut, 'TestFont.json')),
        expect.any(String),
      );
      expect(paths).toHaveLength(2); // JSON + Meta
    });

    it('should save metadata always', async () => {
      await MSDFUtils.saveMSDFOutput(mockResult, './out');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join(path.resolve('./out'), 'TestFont-meta.json')),
        expect.any(String),
      );
    });

    it('should use fallback output options correctly', async () => {
      await MSDFUtils.saveMSDFOutput(
        {
          success: true,
          fontName: 'font',
          metadata: { version: '1.0' },
          atlases: [{ texture: Buffer.alloc(0) }, { texture: Buffer.alloc(0) }] as never,
        } as unknown as MSDFSuccess,
        './out',
      );
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should use custom filename', async () => {
      await MSDFUtils.saveMSDFOutput(mockResult, './out', { filename: 'CustomName' });
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join(path.resolve('./out'), 'CustomName.json')),
        expect.any(String),
      );
    });

    it('should use default filename if fontName is missing', async () => {
      const resultNoName = { ...mockResult, fontName: undefined } as unknown as MSDFSuccess;
      await MSDFUtils.saveMSDFOutput(resultNoName, './out');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join(path.resolve('./out'), 'font.json')),
        expect.any(String),
      );
    });

    it('should write atlases/textures', async () => {
      const resultWithAtlas: MSDFSuccess = {
        ...mockResult,
        atlases: [{ filename: 'atlas.png', texture: Buffer.from('tex') }],
      };
      await MSDFUtils.saveMSDFOutput(resultWithAtlas, './out');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join(path.resolve('./out'), 'TestFont.png')),
        expect.any(Buffer),
      );
    });

    it('should write XML when present', async () => {
      const resultWithXml: MSDFSuccess = {
        ...mockResult,
        xml: '<fnt></fnt>',
      };
      await MSDFUtils.saveMSDFOutput(resultWithXml, './out', { format: 'fnt' });
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join(path.resolve('./out'), 'TestFont.fnt')),
        '<fnt></fnt>',
      );
    });

    it('should NOT write XML if missing from result despite format being fnt', async () => {
      const resultNoXml = {
        ...mockResult,
        success: true,
        fontName: 'Test',
        xml: undefined,
      } as unknown as MSDFSuccess;
      const paths = await MSDFUtils.saveMSDFOutput(resultNoXml, './out', { format: 'fnt' });
      // It always writes metadata, so paths should contain only the metadata file
      expect(paths).toHaveLength(1);
      expect(paths[0]).toContain('Test-meta.json');
      expect(fs.writeFile).not.toHaveBeenCalledWith(
        expect.stringContaining('.fnt'),
        expect.any(String),
      );
    });

    it('should write XML for all relevant formats', async () => {
      const resultWithXml = {
        ...mockResult,
        success: true,
        fontName: 'T',
        xml: '<x></x>',
        metadata: {},
      } as unknown as MSDFSuccess;
      await MSDFUtils.saveMSDFOutput(resultWithXml, './out', { format: 'both' });
      await MSDFUtils.saveMSDFOutput(resultWithXml, './out', { format: 'all' });
      // Verify XML was written at least once
      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('.fnt'), '<x></x>');
    });

    it('should return empty array for failed or cached results', async () => {
      const failed = { success: false, fontName: '', error: '' } as MSDFFailure;
      const cached = {
        success: true,
        cached: true,
        fontName: '',
        metadata: {} as unknown as MSDFCachedSuccess['metadata'],
        savedFiles: [],
      } as MSDFCachedSuccess;
      expect(await MSDFUtils.saveMSDFOutput(failed, './out')).toEqual([]);
      expect(await MSDFUtils.saveMSDFOutput(cached, './out')).toEqual([]);
    });
  });

  describe('createProgressCallback', () => {
    it('should write to stdout when verbose is true', () => {
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const callback = MSDFUtils.createProgressCallback(true);

      callback(10, 1, 10);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Progress: 10%'));

      callback(100, 10, 10);
      expect(spy).toHaveBeenCalledWith('\n');

      spy.mockRestore();
    });

    it('should not write to stdout when verbose is false', () => {
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const callback = MSDFUtils.createProgressCallback(false);

      callback(10, 1, 10);
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    });

    it('should only write when progress increases', () => {
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const callback = MSDFUtils.createProgressCallback(true);

      callback(10, 1, 10);
      const callCount = spy.mock.calls.length;

      callback(10.1, 1, 10); // Same rounded progress
      expect(spy.mock.calls.length).toBe(callCount);

      spy.mockRestore();
    });
  });

  describe('Smart Re-use Utils', () => {
    it('should return expected files list (json)', () => {
      const files = MSDFUtils.getExpectedFiles('./out', 'font', 'json');
      const resolvedOut = path.resolve('./out');
      expect(files).toContain(path.join(resolvedOut, 'font.json'));
      expect(files).toContain(path.join(resolvedOut, 'font-meta.json'));
    });

    it('should return expected files list (both)', () => {
      const files = MSDFUtils.getExpectedFiles('./out', 'font', 'both');
      const resolvedOut = path.resolve('./out');
      expect(files).toContain(path.join(resolvedOut, 'font.json'));
      expect(files).toContain(path.join(resolvedOut, 'font-meta.json'));
    });

    it('should return expected files list (other/binary)', () => {
      const files = MSDFUtils.getExpectedFiles(
        './out',
        'font',
        'binary' as unknown as OutputFormat,
      );
      const resolvedOut = path.resolve('./out');
      expect(files).not.toContain(path.join(resolvedOut, 'font.json'));
      expect(files).toContain(path.join(resolvedOut, 'font-meta.json'));
    });

    describe('loadMetadata', () => {
      it('should return null if file does not exist', async () => {
        vi.mocked(fs.readFile).mockRejectedValueOnce({ code: 'ENOENT' });
        const result = await MSDFUtils.loadMetadata('./out', 'font');
        expect(result).toBe(null);
      });

      it('should return null if JSON is malformed', async () => {
        vi.mocked(fs.readFile).mockResolvedValueOnce('invalid json');
        const result = await MSDFUtils.loadMetadata('./out', 'font');
        expect(result).toBe(null);
      });
    });

    it('should check if MSDF output exists (all files present, default options)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      const result = await MSDFUtils.checkMSDFOutputExists('./out', 'font');
      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalled();
    });

    it('should support verbose logging', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('{"atlasCount":1,"version":"1.0"}');
      vi.mocked(fs.access).mockResolvedValue(undefined);
      await MSDFUtils.checkMSDFOutputExists('./out', 'F', { verbose: true });
    });

    it('should return false if any file is missing', async () => {
      vi.mocked(fs.access).mockRejectedValueOnce(new Error('Missing'));
      const result = await MSDFUtils.checkMSDFOutputExists('./out', 'font');
      expect(result).toBe(false);
    });

    it('should return false if metadata version mismatches', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('{"version":"0.9","atlasCount":1}');
      const result = await MSDFUtils.checkMSDFOutputExists('./out', 'font');
      expect(result).toBe(false);
    });

    it('should default missing atlasCount to 1', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('{"version":"1.0"}');
      vi.mocked(fs.access).mockResolvedValue(undefined);
      const result = await MSDFUtils.checkMSDFOutputExists('./out', 'font');
      expect(result).toBe(true);
    });

    it('should return false if access throws unexpectedly', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('Fatal'));
      const result = await MSDFUtils.checkMSDFOutputExists('./out', 'font');
      expect(result).toBe(false);
    });
  });
});
