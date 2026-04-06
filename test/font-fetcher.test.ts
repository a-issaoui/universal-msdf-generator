import { promises as fs } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FontFetcher from '../src/font-fetcher.js';
import type { FontSource } from '../src/types.js';

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
  statSync: vi.fn(),
}));

// Helper type to access private FontFetcher methods in tests
type FontFetcherPrivate = {
  detectSourceType(source: FontSource | { byteLength: number }): Promise<string>;
  extractLatinFontUrl(css: string, format: string): string | null;
  detectFormatFromUrl(url: string): string;
  extractFontNameFromUrl(url: string): string;
  makeRequest(url: string): Promise<Response>;
};

const priv = (f: FontFetcher) => f as unknown as FontFetcherPrivate;

// Typed mock fetch helpers
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('FontFetcher', () => {
  let fetcher: FontFetcher;

  beforeEach(() => {
    fetcher = new FontFetcher({ timeout: 100 });
    vi.clearAllMocks();
  });

  describe('detectSourceType', () => {
    it('should detect Google Font names', async () => {
      expect(await priv(fetcher).detectSourceType('Open Sans')).toBe('google');
      expect(await priv(fetcher).detectSourceType('Roboto-Bold')).toBe('google');
    });

    it('should detect URLs', async () => {
      expect(await priv(fetcher).detectSourceType('https://example.com/font.ttf')).toBe('url');
      expect(await priv(fetcher).detectSourceType('http://fonts.com/test.woff')).toBe('url');
    });

    it('should detect URL object', async () => {
      expect(
        await priv(fetcher).detectSourceType(new URL('https://ex.com') as unknown as string),
      ).toBe('url');
    });

    it('should detect local files', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as unknown as Awaited<
        ReturnType<typeof fs.stat>
      >);
      expect(await priv(fetcher).detectSourceType('./font.ttf')).toBe('local');
    });

    it('should handle non-file local paths', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false } as unknown as Awaited<
        ReturnType<typeof fs.stat>
      >);
      expect(await priv(fetcher).detectSourceType('./directory')).toBe('unknown');
    });

    it('should handle missing local files', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('Missing'));
      expect(await priv(fetcher).detectSourceType('not-a-font.txt')).toBe('unknown');
    });

    it('should detect buffers', async () => {
      expect(await priv(fetcher).detectSourceType(Buffer.alloc(10))).toBe('buffer');
      expect(await priv(fetcher).detectSourceType(new ArrayBuffer(10) as unknown as string)).toBe(
        'buffer',
      );
      expect(await priv(fetcher).detectSourceType({ byteLength: 10 })).toBe('buffer');
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

    it('should support URL object in main fetch', async () => {
      const spy = vi
        .spyOn(fetcher, 'fetchFromUrl')
        .mockResolvedValue({} as unknown as Awaited<ReturnType<typeof fetcher.fetchFromUrl>>);
      await fetcher.fetch(new URL('https://example.com/font.ttf'));
      expect(spy).toHaveBeenCalled();
    });

    it('should route to fetchLocalFile', async () => {
      const spy = vi
        .spyOn(fetcher, 'fetchLocalFile')
        .mockResolvedValue({ buffer: Buffer.alloc(0), name: 'test', source: 'local', path: 'p' });
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as unknown as Awaited<
        ReturnType<typeof fs.stat>
      >);
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
      const result = await fetcher.fetch(arrayBuffer as unknown as FontSource);
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
    });

    it('should throw for unknown types', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('Unknown'));
      await expect(fetcher.fetch('!!!')).rejects.toThrow('Unsupported font source type');
    });
  });

  describe('fetchGoogleFont', () => {
    it('should fetch and parse Google Fonts CSS', async () => {
      const mockCss = '@font-face { src: url("https://fonts.gstatic.com/test.woff2") }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
        });

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.name).toBe('Roboto');
      expect(result.source).toBe('google');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should use style="italic" correctly', async () => {
      const mockCss = '@font-face { src: url("t.woff2") }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
        });
      const result = await fetcher.fetchGoogleFont('Roboto', { style: 'italic' });
      expect(result.style).toBe('italic');
    });

    it('should throw if font URL cannot be extracted', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('no url here'),
      });
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow('Could not extract font URL');
    });

    it('should handle fetch errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow(
        'Failed to fetch Google Font',
      );
    });

    it('should handle non-Error catch in fetchGoogleFont', async () => {
      mockFetch.mockRejectedValueOnce('google-string-fail');
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow('google-string-fail');
    });

    it('should return null if no font URLs can be parsed from CSS', () => {
      const result = priv(fetcher).extractLatinFontUrl('@font-face { color: red; }', 'any');
      expect(result).toBeNull();
    });

    it('should return null if CSS contains no @font-face blocks', () => {
      const result = priv(fetcher).extractLatinFontUrl('void', 'any');
      expect(result).toBeNull();
    });

    it('should throw if font download fails with HTTP error', async () => {
      const mockCss = '@font-face { src: url("https://fonts.gstatic.com/test.woff2") }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        });

      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow('HTTP 500');
    });

    it('should parse complex Unicode ranges correctly', async () => {
      const mockCss = `
        @font-face {
          src: url("https://fonts.gstatic.com/cyrillic.woff2");
          unicode-range: U+0400-045F;
        }
        @font-face {
          src: url("https://fonts.gstatic.com/latin.woff2");
          unicode-range: U+0000-00FF, U+0131, U+0152-0153;
        }
        @font-face {
          src: url("https://fonts.gstatic.com/single.woff2");
          unicode-range: U+0041;
        }
      `;
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
        });

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.source).toBe('google');
    });

    it('should test single non-latin unicode segment', async () => {
      const mockCss = '@font-face { src: url("t.woff2"); unicode-range: U+0042; }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
        });
      await fetcher.fetchGoogleFont('Roboto');
    });

    it('should handle invalid unicode segments gracefully', async () => {
      const mockCss = '@font-face { src: url("t.woff2"); unicode-range: INVALID; }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
        });
      await fetcher.fetchGoogleFont('Roboto');
    });

    it('should support "any" format in fetchGoogleFont', async () => {
      const mockCss = '@font-face { src: url("https://fonts.gstatic.com/test.ttf") }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
        });

      const result = await fetcher.fetchGoogleFont('Roboto', { format: 'any' });
      expect(result.format).toBe('any');
    });

    it('should fall back to raw parsed blocks if preferred format is missing', () => {
      const mockCss = '@font-face { src: url("test.ttf") }';
      const result = priv(fetcher).extractLatinFontUrl(mockCss, 'woff2');
      expect(result).toBe('test.ttf');
    });
  });

  describe('fetchFromUrl', () => {
    it('should fetch from URL and detect metadata', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });

      const result = await fetcher.fetchFromUrl('https://example.com/MyFont.ttf');
      expect(result.name).toBe('MyFont');
      expect(result.format).toBe('ttf');
      expect(result.source).toBe('url');
    });

    it('should support URL object as input in fetchFromUrl', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      const result = await fetcher.fetchFromUrl(new URL('https://example.com/MyFont.ttf'));
      expect(result.originalUrl).toBe('https://example.com/MyFont.ttf');
    });

    it('should respect explicit name in fetchFromUrl', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      const result = await fetcher.fetchFromUrl('https://ex.com/Font.ttf', { name: 'Explicit' });
      expect(result.name).toBe('Explicit');
    });

    it('should fall back to unknown-font if name is not extracted', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      vi.spyOn(
        priv(fetcher) as unknown as { extractFontNameFromUrl(u: string): string },
        'extractFontNameFromUrl',
      ).mockReturnValue('');
      const result = await fetcher.fetchFromUrl('https://example.com/Font.ttf');
      expect(result.name).toBe('unknown-font');
    });

    it('should handle non-Error catch in fetchFromUrl', async () => {
      mockFetch.mockRejectedValueOnce('string-fail');
      await expect(fetcher.fetchFromUrl('https://ex.com')).rejects.toThrow('string-fail');
    });

    it('should handle unknown font format', async () => {
      const result = priv(fetcher).detectFormatFromUrl('https://example.com/font.unknown');
      expect(result).toBe('unknown');
    });

    it('should handle HTTP errors', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      await expect(fetcher.fetchFromUrl('https://example.com/404.ttf')).rejects.toThrow('HTTP 404');
    });

    it('should handle URL parsing failure', async () => {
      const result = priv(fetcher).extractFontNameFromUrl('not-a-url');
      expect(result).toBe('unknown-font');
    });

    it('should extract name from URL with query params', () => {
      const result = priv(fetcher).extractFontNameFromUrl('https://ex.com/Font.ttf?v=1');
      expect(result).toBe('Font');
    });
  });

  describe('fetchLocalFile', () => {
    it('should read local file', async () => {
      const buffer = Buffer.from('test');
      vi.mocked(fs.readFile).mockResolvedValue(buffer);

      const result = await fetcher.fetchLocalFile('test.ttf');
      expect(result.buffer.toString()).toBe(buffer.toString());
      expect(result.name).toBe('test');
      expect(result.source).toBe('local');
    });

    it('should handle read errors', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));
      await expect(fetcher.fetchLocalFile('missing.ttf')).rejects.toThrow(
        'Failed to read local font file',
      );
    });

    it('should handle non-Error catch in fetchLocalFile', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce('read-fail');
      await expect(fetcher.fetchLocalFile('fail.ttf')).rejects.toThrow('read-fail');
    });
  });

  describe('makeRequest', () => {
    it('should handle non-Error catch in makeRequest', async () => {
      mockFetch.mockRejectedValueOnce('raw-fail');
      await expect(priv(fetcher).makeRequest('https://ex.com')).rejects.toThrow('raw-fail');
    });

    it('should handle timeout', async () => {
      mockFetch.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('AbortError')), 200);
          }),
      );

      await expect(priv(fetcher).makeRequest('http://slow.com')).rejects.toThrow('Request failed');
    });
  });
});
