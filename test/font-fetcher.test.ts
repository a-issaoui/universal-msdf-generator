import { promises as fs } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FontFetcher from '../src/font-fetcher.js';

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
  statSync: vi.fn(),
}));

// Mock global fetch
global.fetch = vi.fn();

describe('FontFetcher', () => {
  let fetcher: FontFetcher;

  beforeEach(() => {
    fetcher = new FontFetcher({ timeout: 100 });
    vi.clearAllMocks();
  });

  describe('detectSourceType', () => {
    it('should detect Google Font names', async () => {
      expect(await (fetcher as any).detectSourceType('Open Sans')).toBe('google');
      expect(await (fetcher as any).detectSourceType('Roboto-Bold')).toBe('google');
    });

    it('should detect URLs', async () => {
      expect(await (fetcher as any).detectSourceType('https://example.com/font.ttf')).toBe('url');
      expect(await (fetcher as any).detectSourceType('http://fonts.com/test.woff')).toBe('url');
    });

    it('should detect local files', async () => {
      (fs.stat as any).mockResolvedValue({ isFile: () => true });
      expect(await (fetcher as any).detectSourceType('./font.ttf')).toBe('local');
    });

    it('should handle missing local files', async () => {
      (fs.stat as any).mockRejectedValue(new Error('Missing'));
      expect(await (fetcher as any).detectSourceType('not-a-font.txt')).toBe('unknown');
    });

    it('should detect buffers', async () => {
      expect(await (fetcher as any).detectSourceType(Buffer.alloc(10))).toBe('buffer');
      expect(await (fetcher as any).detectSourceType(new ArrayBuffer(10))).toBe('buffer');
      expect(await (fetcher as any).detectSourceType({ byteLength: 10 })).toBe('buffer');
    });
  });

  describe('fetch', () => {
    it('should route to fetchGoogleFont', async () => {
      const spy = vi
        .spyOn(fetcher, 'fetchGoogleFont')
        .mockResolvedValue({ buffer: Buffer.alloc(0), name: 'test', source: 'google' });
      await fetcher.fetch('Open Sans');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should route to fetchFromUrl', async () => {
      const spy = vi
        .spyOn(fetcher, 'fetchFromUrl')
        .mockResolvedValue({ buffer: Buffer.alloc(0), name: 'test', source: 'url' });
      await fetcher.fetch('https://example.com/font.ttf');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should route to fetchLocalFile', async () => {
      const spy = vi
        .spyOn(fetcher, 'fetchLocalFile')
        .mockResolvedValue({ buffer: Buffer.alloc(0), name: 'test', source: 'local', path: 'p' });
      (fs.stat as any).mockResolvedValue({ isFile: () => true });
      await fetcher.fetch('./font.ttf');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should handle buffers directly', async () => {
      const buffer = Buffer.from('test');
      const result = await fetcher.fetch(buffer);
      expect(result.buffer.toString()).toBe(buffer.toString());
      expect(result.source).toBe('buffer');
    });

    it('should convert raw objects to buffers', async () => {
      const data = Buffer.from([1, 2, 3]);
      const result = await fetcher.fetch(data);
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.source).toBe('buffer');
    });

    it('should handle raw ArrayBuffer input', async () => {
      const arrayBuffer = new ArrayBuffer(10);
      const result = await fetcher.fetch(arrayBuffer as any);
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
    });

    it('should throw for unknown types', async () => {
      (fs.stat as any).mockRejectedValue(new Error('Unknown'));
      await expect(fetcher.fetch('!!!')).rejects.toThrow('Unsupported font source type');
    });
  });

  describe('fetchGoogleFont', () => {
    it('should fetch and parse Google Fonts CSS', async () => {
      const mockCss = '@font-face { src: url("https://fonts.gstatic.com/test.woff2") }';
      (global.fetch as any)
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })

        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
        });

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.name).toBe('Roboto');
      expect(result.source).toBe('google');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should throw if font URL cannot be extracted', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('no url here'),
      });
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow('Could not extract font URL');
    });

    it('should handle fetch errors', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network error'));
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow(
        'Failed to fetch Google Font',
      );
    });

    it('should handle non-Error catch in fetchGoogleFont', async () => {
      (global.fetch as any).mockRejectedValueOnce('google-string-fail');
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow('google-string-fail');
    });

    it('should support "any" format in fetchGoogleFont', async () => {
      const mockCss = '@font-face { src: url("https://fonts.gstatic.com/test.ttf") }';
      (global.fetch as any)
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })

        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
        });

      const result = await fetcher.fetchGoogleFont('Roboto', { format: 'any' });
      expect(result.format).toBe('any');
    });
  });

  describe('fetchFromUrl', () => {
    it('should fetch from URL and detect metadata', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });

      const result = await fetcher.fetchFromUrl('https://example.com/MyFont.ttf');
      expect(result.name).toBe('MyFont');
      expect(result.format).toBe('ttf');
      expect(result.source).toBe('url');
    });

    it('should respect explicit name in fetchFromUrl', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      const result = await fetcher.fetchFromUrl('https://ex.com/Font.ttf', { name: 'Explicit' });
      expect(result.name).toBe('Explicit');
    });

    it('should fall back to unknown-font if name is not extracted', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      // Mock extractFontNameFromUrl to return empty
      vi.spyOn(fetcher as any, 'extractFontNameFromUrl').mockReturnValue('');
      const result = await fetcher.fetchFromUrl('https://example.com/Font.ttf');
      expect(result.name).toBe('unknown-font');
    });

    it('should handle non-Error catch in fetchFromUrl', async () => {
      (global.fetch as any).mockRejectedValueOnce('string-fail');
      await expect(fetcher.fetchFromUrl('https://ex.com')).rejects.toThrow('string-fail');
    });

    it('should handle unknown font format', async () => {
      const result = (fetcher as any).detectFormatFromUrl('https://example.com/font.unknown');
      expect(result).toBe('unknown');
    });

    it('should handle HTTP errors', async () => {
      (global.fetch as any).mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      await expect(fetcher.fetchFromUrl('https://example.com/404.ttf')).rejects.toThrow('HTTP 404');
    });

    it('should handle URL parsing failure', async () => {
      const result = (fetcher as any).extractFontNameFromUrl('not-a-url');
      expect(result).toBe('unknown-font');
    });

    it('should extract name from URL with query params', () => {
      const result = (fetcher as any).extractFontNameFromUrl('https://ex.com/Font.ttf?v=1');
      expect(result).toBe('Font');
    });
  });

  describe('fetchLocalFile', () => {
    it('should read local file', async () => {
      const buffer = Buffer.from('test');
      (fs.readFile as any).mockResolvedValue(buffer);

      const result = await fetcher.fetchLocalFile('test.ttf');
      expect(result.buffer.toString()).toBe(buffer.toString());
      expect(result.name).toBe('test');
      expect(result.source).toBe('local');
    });

    it('should handle read errors', async () => {
      (fs.readFile as any).mockRejectedValue(new Error('File not found'));
      await expect(fetcher.fetchLocalFile('missing.ttf')).rejects.toThrow(
        'Failed to read local font file',
      );
    });

    it('should handle non-Error catch in fetchLocalFile', async () => {
      (fs.readFile as any).mockRejectedValueOnce('read-fail');
      await expect(fetcher.fetchLocalFile('fail.ttf')).rejects.toThrow('read-fail');
    });
  });

  describe('makeRequest', () => {
    it('should handle non-Error catch in makeRequest', async () => {
      (global.fetch as any).mockRejectedValueOnce('raw-fail');
      await expect((fetcher as any).makeRequest('https://ex.com')).rejects.toThrow('raw-fail');
    });

    it('should handle timeout', async () => {
      (global.fetch as any).mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('AbortError')), 200);
          }),
      );

      await expect((fetcher as any).makeRequest('http://slow.com')).rejects.toThrow(
        'Request failed',
      );
    });
  });
});
