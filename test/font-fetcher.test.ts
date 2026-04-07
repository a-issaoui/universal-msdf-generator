import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FontFetcher from '../src/font-fetcher.js';
import type { FontData, FontSource } from '../src/types.js';

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
  statSync: vi.fn(),
}));

// Mock DNS lookups so tests don't make real network calls and never block
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue({ address: '1.1.1.1', family: 4 }),
}));

// Helper type to access private FontFetcher methods in tests
type FontFetcherPrivate = {
  detectSourceType(source: FontSource | { byteLength: number }): Promise<string>;
  extractLatinFontUrl(css: string, format: 'woff' | 'ttf' | 'any'): string | null;
  detectFormatFromUrl(url: string): string;
  detectFormatFromBuffer(buf: Buffer): string | null;
  extractFontNameFromUrl(url: string): string;
  makeRequest(
    url: string,
    options?: { userAgent?: string; signal?: AbortSignal },
  ): Promise<Response>;
  validateUrlSecurity(url: URL): void;
};

const priv = (f: FontFetcher) => f as unknown as FontFetcherPrivate;

// Typed mock fetch helpers
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Valid magic-byte buffers for font format tests
const woffMagic = (): ArrayBuffer => {
  const buf = new Uint8Array(10);
  buf[0] = 0x77;
  buf[1] = 0x4f;
  buf[2] = 0x46;
  buf[3] = 0x46; // wOFF
  return buf.buffer;
};
const ttfMagic = (): ArrayBuffer => {
  const buf = new Uint8Array(10);
  buf[0] = 0x00;
  buf[1] = 0x01;
  buf[2] = 0x00;
  buf[3] = 0x00; // TTF
  return buf.buffer;
};

describe('FontFetcher', () => {
  let fetcher: FontFetcher;

  beforeEach(() => {
    // maxRetries: 1 prevents exponential-backoff delays in tests
    fetcher = new FontFetcher({ timeout: 100, maxRetries: 1 });
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

    it('should handle non-file local paths (directory)', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => false,
        isDirectory: () => true,
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);
      await expect(priv(fetcher).detectSourceType('./directory')).rejects.toThrow(
        'Path is a directory',
      );
    });

    it('should handle missing local files', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('Missing'));
      expect(await priv(fetcher).detectSourceType('not-a-font.txt')).toBe('unknown');
    });

    it('should return unknown for special filesystem entries (not file, not directory)', async () => {
      // stat succeeds but isFile()=false and isDirectory()=false (e.g. socket, device node)
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => false,
        isDirectory: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);
      expect(await priv(fetcher).detectSourceType('./socket-or-device')).toBe('unknown');
    });

    it('should detect bare filename with extension as local via fallback stat', async () => {
      // "font.ttf" has no path indicators and doesn't match Google name regex (has dot)
      // → falls through to fallback stat check
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as unknown as Awaited<
        ReturnType<typeof fs.stat>
      >);
      expect(await priv(fetcher).detectSourceType('font.ttf')).toBe('local');
    });

    it('should detect buffers', async () => {
      expect(await priv(fetcher).detectSourceType(Buffer.alloc(10))).toBe('buffer');
      expect(await priv(fetcher).detectSourceType(new ArrayBuffer(10) as unknown as string)).toBe(
        'buffer',
      );
    });

    it('should detect TypedArray (Uint8Array) as buffer', async () => {
      expect(
        await priv(fetcher).detectSourceType(new Uint8Array(10) as unknown as FontSource),
      ).toBe('buffer');
    });

    it('should NOT treat plain objects with byteLength as buffer', async () => {
      // Old heuristic ({ byteLength: N }) was fragile — any object matched.
      // Now only real Buffer / ArrayBuffer / ArrayBufferView are accepted.
      expect(await priv(fetcher).detectSourceType({ byteLength: 10 })).toBe('unknown');
    });

    it('should treat whitespace-only string as unknown (not a Google font name)', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
      expect(await priv(fetcher).detectSourceType('   ')).toBe('unknown');
    });

    it('should treat digits-only string as unknown (not a Google font name)', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
      expect(await priv(fetcher).detectSourceType('123')).toBe('unknown');
    });

    it('should treat hyphens-only string as unknown (not a Google font name)', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
      expect(await priv(fetcher).detectSourceType('---')).toBe('unknown');
    });

    it('should stat path-like strings before checking Google heuristic', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as unknown as Awaited<
        ReturnType<typeof fs.stat>
      >);
      // "./Roboto Regular" starts with ./ — goes to stat, not Google font heuristic
      expect(await priv(fetcher).detectSourceType('./Roboto Regular')).toBe('local');
    });

    it('should throw for path-like strings that do not exist (ENOENT)', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      vi.mocked(fs.stat).mockRejectedValue(err);
      await expect(priv(fetcher).detectSourceType('/nonexistent/font')).rejects.toThrow(
        'File not found',
      );
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
        .mockResolvedValue({ buffer: Buffer.alloc(0), name: 'test', source: 'url' });
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

    it('should handle raw ArrayBuffer input', async () => {
      const arrayBuffer = new ArrayBuffer(10);
      const result = await fetcher.fetch(arrayBuffer as unknown as FontSource);
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.source).toBe('buffer');
    });

    it('should handle Uint8Array input', async () => {
      const arr = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await fetcher.fetch(arr as unknown as FontSource);
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.buffer).toEqual(Buffer.from([1, 2, 3, 4, 5]));
      expect(result.source).toBe('buffer');
    });

    it('protectBuffer: prevents mutation of returned buffer in development', async () => {
      const arr = new Uint8Array([1, 2, 3]);
      const result = await fetcher.fetch(arr as unknown as FontSource);

      // Attempting to mutate via write/fill/set should throw
      expect(() => result.buffer.write('X')).toThrow(/Cannot mutate cached font buffer/);
      expect(() => result.buffer.fill(0)).toThrow(/Cannot mutate cached font buffer/);
      expect(() => (result.buffer as Buffer & { set: (v: number[]) => void }).set([0])).toThrow(
        /Cannot mutate cached font buffer/,
      );
    });

    it('should correctly handle Uint8Array sub-views (byteOffset > 0)', async () => {
      // Backing buffer has 8 bytes; view covers bytes 2–5 (length 4)
      const backing = new ArrayBuffer(8);
      const full = new Uint8Array(backing);
      full.set([10, 20, 30, 40, 50, 60, 70, 80]);
      const subView = new Uint8Array(backing, 2, 4); // [30, 40, 50, 60]

      const result = await fetcher.fetch(subView as unknown as FontSource);
      expect([...result.buffer]).toEqual([30, 40, 50, 60]);
    });

    it('should throw for unknown types', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('Unknown'));
      await expect(fetcher.fetch('!!!')).rejects.toThrow('Unsupported font source type');
    });
  });

  describe('fetchGoogleFont', () => {
    it('should fetch and parse Google Fonts CSS', async () => {
      const mockCss = '@font-face { src: url("https://fonts.gstatic.com/test.woff") }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(woffMagic()),
        });

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.name).toBe('Roboto');
      expect(result.source).toBe('google');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should use style="italic" correctly', async () => {
      // URL must be a valid https:// URL so new URL(fontUrl) + validateUrlSecurity pass
      const mockCss = '@font-face { src: url("https://fonts.gstatic.com/t.woff") }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(woffMagic()),
        });
      const result = await fetcher.fetchGoogleFont('Roboto', { style: 'italic' });
      expect(result.style).toBe('italic');
    });

    it('should throw if font URL cannot be extracted from any attempt', async () => {
      // All 3 attempts get CSS with no usable URLs → all fail
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('no url here'),
      });
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow(
        'Failed to fetch Google Font',
      );
    });

    it('should handle fetch errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow(
        'Failed to fetch Google Font',
      );
    });

    it('should handle non-Error catch in fetchGoogleFont', async () => {
      // Reject all attempts — string rejection propagates via extractMessage
      mockFetch.mockRejectedValue('google-string-fail');
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
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              '@font-face { src: url(https://fonts.gstatic.com/test.woff) format("woff"); }',
            ),
        })
        .mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Error' });

      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow(/HTTP 500/);
    });

    it('should parse complex Unicode ranges correctly', async () => {
      const mockCss = `
        @font-face {
          src: url("https://fonts.gstatic.com/cyrillic.woff");
          unicode-range: U+0400-045F;
        }
        @font-face {
          src: url("https://fonts.gstatic.com/latin.woff");
          unicode-range: U+0000-00FF, U+0131, U+0152-0153;
        }
        @font-face {
          src: url("https://fonts.gstatic.com/single.woff");
          unicode-range: U+0041;
        }
      `;
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(woffMagic()),
        });

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.source).toBe('google');
    });

    it('should test single non-latin unicode segment', async () => {
      const mockCss =
        '@font-face { src: url("https://fonts.gstatic.com/t.woff"); unicode-range: U+0042; }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(woffMagic()),
        });
      await fetcher.fetchGoogleFont('Roboto');
    });

    it('should handle invalid unicode segments gracefully', async () => {
      const mockCss =
        '@font-face { src: url("https://fonts.gstatic.com/t.woff"); unicode-range: INVALID; }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockCss) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(woffMagic()),
        });
      await fetcher.fetchGoogleFont('Roboto');
    });

    it('falls back to TTF when WOFF not available (e.g. Playwrite-era fonts)', async () => {
      // Attempt 1 (IE11 UA): CSS has no WOFF URL
      const noWoffCss = '@font-face { src: url("https://fonts.gstatic.com/test.woff2") }';
      // Attempt 2 (Android UA): CSS has TTF URL
      const ttfCss = '@font-face { src: url("https://fonts.gstatic.com/test.ttf") }';
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(noWoffCss) }) // attempt 1 CSS
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(ttfCss) }) // attempt 2 CSS
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(ttfMagic()),
        }); // TTF download

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.format).toBe('ttf');
      expect(result.source).toBe('google');
    });

    it('should return null when preferred format is missing (strict filter)', () => {
      // CSS only has TTF; requesting WOFF → no match → null
      const mockCss = '@font-face { src: url("test.ttf") format("truetype") }';
      const result = priv(fetcher).extractLatinFontUrl(mockCss, 'woff');
      expect(result).toBeNull();
    });

    it('should fall back to any URL when format is "any"', () => {
      const mockCss = '@font-face { src: url("test.ttf") }';
      const result = priv(fetcher).extractLatinFontUrl(mockCss, 'any');
      expect(result).toBe('test.ttf');
    });

    it('handles CSS with nested braces in block content (braceCount branch)', () => {
      // A nested { } inside the @font-face block triggers the braceCount++ branch
      const mockCss = '@font-face { src: url("test.ttf"); @supports { display: block } }';
      const result = priv(fetcher).extractLatinFontUrl(mockCss, 'any');
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
      mockFetch.mockRejectedValue('string-fail');
      await expect(fetcher.fetchFromUrl('https://ex.com')).rejects.toThrow();
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

    it('should reject file:// protocol', async () => {
      await expect(fetcher.fetchFromUrl('file:///etc/passwd')).rejects.toThrow('not allowed');
    });

    it('should reject ftp:// protocol', async () => {
      await expect(fetcher.fetchFromUrl('ftp://example.com/font.ttf')).rejects.toThrow(
        'not allowed',
      );
    });

    it('should reject invalid URL string', async () => {
      await expect(fetcher.fetchFromUrl('not a url at all')).rejects.toThrow('Invalid URL');
    });
  });

  describe('fetchLocalFile', () => {
    const okStat = {
      isFile: () => true,
      size: 100,
    } as unknown as Awaited<ReturnType<typeof fs.stat>>;

    it('should read local file', async () => {
      const buffer = Buffer.from('test');
      vi.mocked(fs.stat).mockResolvedValue(okStat);
      vi.mocked(fs.readFile).mockResolvedValue(buffer);

      const result = await fetcher.fetchLocalFile('test.ttf');
      expect(result.buffer.toString()).toBe(buffer.toString());
      expect(result.name).toBe('test');
      expect(result.source).toBe('local');
    });

    it('should handle stat access errors', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('EACCES'));
      await expect(fetcher.fetchLocalFile('missing.ttf')).rejects.toThrow(
        'Failed to access local file',
      );
    });

    it('should handle read errors', async () => {
      vi.mocked(fs.stat).mockResolvedValue(okStat);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('EACCES'));
      await expect(fetcher.fetchLocalFile('locked.ttf')).rejects.toThrow(
        'Failed to read local file',
      );
    });

    it('should handle non-Error catch in fetchLocalFile', async () => {
      vi.mocked(fs.stat).mockResolvedValue(okStat);
      vi.mocked(fs.readFile).mockRejectedValueOnce('read-fail');
      await expect(fetcher.fetchLocalFile('fail.ttf')).rejects.toThrow('read-fail');
    });

    it('should throw if basePath is not absolute', () => {
      expect(() => new FontFetcher({ basePath: './relative' })).toThrow(
        /basePath must be an absolute path/,
      );
    });

    it('should normalize valid basePath', () => {
      // Use process.cwd() as a safe absolute path for testing
      const base = path.join(process.cwd(), 'fonts/');
      const fetcherWithBase = new FontFetcher({ basePath: base });
      // @ts-expect-error - accessing private options for verification
      expect(fetcherWithBase.options.basePath).toBe(path.normalize(base));
    });

    it('should reject path traversal when basePath is set', async () => {
      const secureFetcher = new FontFetcher({ basePath: '/safe/fonts', maxRetries: 1 });
      await expect(secureFetcher.fetchLocalFile('../../etc/passwd')).rejects.toThrow(
        'Path traversal detected',
      );
    });

    it('should enforce file size limit', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 25 * 1024 * 1024,
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);
      const smallFetcher = new FontFetcher({ maxDownloadSize: 1024, maxRetries: 1 });
      await expect(smallFetcher.fetchLocalFile('huge.ttf')).rejects.toThrow('too large');
    });

    it('should throw when path exists but is not a file', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => false,
        size: 0,
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);
      await expect(fetcher.fetchLocalFile('special-path')).rejects.toThrow('Path is not a file');
    });
  });

  describe('makeRequest', () => {
    it('should handle non-Error catch in makeRequest', async () => {
      mockFetch.mockRejectedValueOnce('raw-fail');
      await expect(priv(fetcher).makeRequest('https://ex.com')).rejects.toThrow('raw-fail');
    });

    it('should handle timeout — re-throws AbortError as timed-out message', async () => {
      // Create a proper AbortError (name must be 'AbortError' to trigger the branch)
      mockFetch.mockImplementation(
        () =>
          new Promise((_, reject) => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            setTimeout(() => reject(err), 200);
          }),
      );
      await expect(priv(fetcher).makeRequest('http://slow.com')).rejects.toThrow(
        'Request timed out',
      );
    });

    it('fetchWithRetry: throws when maxRetries is exceeded', async () => {
      mockFetch.mockRejectedValue(new Error('Persistent Fail'));
      const retryFetcher = new FontFetcher({ maxRetries: 2, verbose: false });
      vi.spyOn(priv(retryFetcher) as never, 'sleep').mockResolvedValue(undefined);

      await expect(retryFetcher.fetchGoogleFont('Test')).rejects.toThrow(
        'Failed after 2 attempts: Persistent Fail',
      );
    });

    it('fetchWithRetry: retries on 500 error and then fails', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Error' });
      const retryFetcher = new FontFetcher({ maxRetries: 2, verbose: false });
      vi.spyOn(priv(retryFetcher) as never, 'sleep').mockResolvedValue(undefined);

      await expect(retryFetcher.fetchFromUrl('https://example.com/font.ttf')).rejects.toThrow(
        'Failed after 2 attempts: HTTP 500: Internal Error',
      );
    });

    it('fetchWithRetry: handles error without message and default retry count branch', async () => {
      // Mock options to simulate maxRetries undefined/null branch if possible,
      // but FontFetcher options has defaults. We can mock the template literal branch by passing a non-Error.
      mockFetch.mockRejectedValue(new Error(''));
      const retryFetcher = new FontFetcher({ maxRetries: 1, verbose: false });
      vi.spyOn(priv(retryFetcher) as never, 'sleep').mockResolvedValue(undefined);

      await expect(retryFetcher.fetchFromUrl('https://example.com/f.ttf')).rejects.toThrow(
        'Failed after 1 attempts: Unknown error',
      );
    });

    it('fetchWithRetry: handles zero retries branch in error message', async () => {
      mockFetch.mockRejectedValue(new Error('Immediate fail'));
      const retryFetcher = new FontFetcher({ maxRetries: 0, verbose: false });

      await expect(retryFetcher.fetchFromUrl('https://example.com/f.ttf')).rejects.toThrow(
        'Failed after 0 attempts: Immediate fail',
      );
    });

    it('fetchWithRetry: handles zero retries and Unknown Error branch', async () => {
      // We pass maxRetries: 0 to ensure only 1 attempt (the first one) is made.
      const retryFetcher = new FontFetcher({ maxRetries: 0 });
      mockFetch.mockRejectedValue(new Error('')); // Empty message results in Unknown error fallback
      await expect(retryFetcher.fetchFromUrl('https://ex.com')).rejects.toThrow(
        'Failed after 0 attempts: Unknown error',
      );
    });

    it('RateLimiter: waits when tokens are exhausted', async () => {
      // Test the public acquire method which uses timeout
      // We'll create a dedicated RateLimiter for the test to avoid interference
      const { RateLimiter } = (await import('../src/font-fetcher.js')) as unknown as {
        // biome-ignore lint/style/useNamingConvention: property matches class name
        RateLimiter: new (
          tokens: number,
          interval: number,
        ) => { acquire: () => Promise<void> };
      };
      const limiter = new RateLimiter(1, 1000);
      await limiter.acquire(); // tokens: 0

      const _start = Date.now();
      const p = limiter.acquire(); // should wait
      vi.useFakeTimers();
      vi.advanceTimersByTime(1001);
      await p;
      vi.useRealTimers();
    });

    it('should throw immediately when external signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      // signal is already aborted before the request starts
      await expect(
        priv(fetcher).makeRequest('https://ex.com', { signal: controller.signal }),
      ).rejects.toThrow('Request aborted by external signal');
    });

    it('should propagate FetchOptions.signal abort to in-flight request', async () => {
      const controller = new AbortController();
      const customFetcher = new FontFetcher({ signal: controller.signal, maxRetries: 1 });

      // Abort 50ms into a slow fetch (fetcher timeout is 30s default)
      mockFetch.mockImplementation(
        () =>
          new Promise((_, reject) => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            setTimeout(() => reject(err), 200);
          }),
      );

      setTimeout(() => controller.abort(), 50);
      await expect(customFetcher.fetchFromUrl('https://example.com/font.ttf')).rejects.toThrow();
    });
  });

  describe('SSRF protection', () => {
    it('should block localhost', async () => {
      await expect(fetcher.fetchFromUrl('http://localhost/font.ttf')).rejects.toThrow('blocked');
    });

    it('should block private IP 192.168.x.x', async () => {
      await expect(fetcher.fetchFromUrl('http://192.168.1.1/font.ttf')).rejects.toThrow('blocked');
    });

    it('should block link-local 169.254.x.x (AWS metadata)', async () => {
      await expect(fetcher.fetchFromUrl('http://169.254.169.254/font.ttf')).rejects.toThrow(
        'blocked',
      );
    });

    it('should block URLs with embedded credentials', async () => {
      await expect(fetcher.fetchFromUrl('http://user:pass@example.com/font.ttf')).rejects.toThrow(
        'credentials',
      );
    });

    it('should block dangerous service ports (e.g. MySQL 3306)', async () => {
      await expect(fetcher.fetchFromUrl('http://example.com:3306/font.ttf')).rejects.toThrow(
        'port 3306',
      );
    });

    it('should allow standard public URLs', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      const result = await fetcher.fetchFromUrl('https://fonts.gstatic.com/font.ttf');
      expect(result.source).toBe('url');
    });

    it('DNS SSRF: throws when DNS resolution fails', async () => {
      const badDnsFetcher = new FontFetcher({
        dnsResolver: () => Promise.reject(new Error('NXDOMAIN')),
      });
      await expect(badDnsFetcher.fetchFromUrl('https://example.com/font.ttf')).rejects.toThrow(
        'DNS resolution failed',
      );
    });

    it('DNS SSRF: throws when resolved IP is private', async () => {
      const privateDnsFetcher = new FontFetcher({
        dnsResolver: () => Promise.resolve('192.168.1.1'),
      });
      await expect(privateDnsFetcher.fetchFromUrl('https://example.com/font.ttf')).rejects.toThrow(
        'blocked',
      );
    });
  });

  describe('caching and deduplication', () => {
    it('fetch() deduplicates concurrent identical requests', async () => {
      const spy = vi.spyOn(fetcher, 'fetchGoogleFont').mockResolvedValue({
        buffer: Buffer.alloc(4),
        name: 'Roboto',
        source: 'google',
      });

      await Promise.all([fetcher.fetch('Roboto'), fetcher.fetch('Roboto')]);
      // Second call should hit cache, not call fetchGoogleFont again
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('clearCache() removes cached results', async () => {
      const spy = vi.spyOn(fetcher, 'fetchGoogleFont').mockResolvedValue({
        buffer: Buffer.alloc(4),
        name: 'Roboto',
        source: 'google',
      });

      await fetcher.fetch('Roboto');
      fetcher.clearCache();
      await fetcher.fetch('Roboto');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('cancel() returns false when no in-flight request exists', () => {
      expect(fetcher.cancel('Roboto')).toBe(false);
    });

    it('generates different cache keys when googleOptions differ (options branch in generateCacheKey)', async () => {
      const spy = vi.spyOn(fetcher, 'fetchGoogleFont').mockResolvedValue({
        buffer: Buffer.alloc(4),
        name: 'Roboto',
        source: 'google',
      });

      // Call with different googleOptions — each should miss cache and call fetchGoogleFont
      await fetcher.fetch('Roboto', { weight: '400', style: 'normal' });
      await fetcher.fetch('Roboto', { weight: '700', style: 'bold' });
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('cancel() returns true when an in-flight request exists', async () => {
      let settle!: (v: FontData) => void;
      vi.spyOn(fetcher, 'fetchGoogleFont').mockReturnValue(
        new Promise<FontData>((resolve) => {
          settle = resolve;
        }),
      );
      // Start a fetch but don't await it yet — activeRequests is populated synchronously
      const fetchPromise = fetcher.fetch('Roboto');
      // Give the microtask queue a tick so executeFetch starts and registers the controller
      await Promise.resolve();
      expect(fetcher.cancel('Roboto')).toBe(true);
      settle({ buffer: Buffer.alloc(0), name: 'Roboto', source: 'google' });
      await fetchPromise;
    });
  });

  describe('format detection', () => {
    it('detectFormatFromBuffer identifies TTF by magic bytes', () => {
      const ttfBuf = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
      expect(priv(fetcher).detectFormatFromBuffer(ttfBuf)).toBe('ttf');
    });

    it('detectFormatFromBuffer identifies WOFF by magic bytes', () => {
      const woffBuf = Buffer.from([0x77, 0x4f, 0x46, 0x46, 0x00, 0x00]);
      expect(priv(fetcher).detectFormatFromBuffer(woffBuf)).toBe('woff');
    });

    it('detectFormatFromBuffer returns null for unknown data', () => {
      const unknown = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      expect(priv(fetcher).detectFormatFromBuffer(unknown)).toBeNull();
    });

    it('detectFormatFromBuffer returns null for buffers shorter than 4 bytes', () => {
      expect(priv(fetcher).detectFormatFromBuffer(Buffer.from([0x00, 0x01]))).toBeNull();
    });

    it('detectFormatFromUrl uses pathname extension, ignores query params', () => {
      expect(priv(fetcher).detectFormatFromUrl('https://ex.com/font.woff2?v=1')).toBe('woff2');
      expect(priv(fetcher).detectFormatFromUrl('https://ex.com/font.ttf')).toBe('ttf');
      expect(priv(fetcher).detectFormatFromUrl('https://ex.com/font.unknown')).toBe('unknown');
    });
  });

  describe('download size limits', () => {
    it('rejects responses where Content-Length exceeds limit', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: (h: string) => (h === 'content-length' ? '999999999' : null) },
        body: null,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      const smallFetcher = new FontFetcher({ maxDownloadSize: 1024, maxRetries: 1 });
      await expect(smallFetcher.fetchFromUrl('https://example.com/font.ttf')).rejects.toThrow(
        'Content-Length',
      );
    });

    it('rejects when downloaded body exceeds limit (readArrayBuffer path)', async () => {
      // body:null forces readArrayBuffer; actual data (2048 bytes) > maxDownloadSize (1024)
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => null }, // no content-length header
        body: null,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2048)),
      });
      const smallFetcher = new FontFetcher({ maxDownloadSize: 1024, maxRetries: 1 });
      await expect(smallFetcher.fetchFromUrl('https://example.com/font.ttf')).rejects.toThrow(
        'exceeds maximum allowed size',
      );
    });

    it('reads response body via ReadableStream (streaming path)', async () => {
      // Provide a real ReadableStream so response.body is truthy → readStream is used
      const data = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x00]); // TTF magic
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        body: stream,
      });
      const result = await fetcher.fetchFromUrl('https://example.com/font.ttf');
      expect(result.format).toBe('ttf');
    });

    it('rejects when streaming body exceeds size limit', async () => {
      // Stream chunks whose total exceeds maxDownloadSize
      const chunk = new Uint8Array(800);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk); // 1600 total > 1024 limit
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        body: stream,
      });
      const smallFetcher = new FontFetcher({ maxDownloadSize: 1024, maxRetries: 1 });
      await expect(smallFetcher.fetchFromUrl('https://example.com/font.ttf')).rejects.toThrow(
        'exceeds maximum allowed size',
      );
    });
  });

  describe('coverage gaps', () => {
    it('validateFontBuffer returns true when no magic bytes but format is unknown', async () => {
      // font.bin has format='unknown'. The filter includes unknown-format blocks for any preferredFormat,
      // so all 3 attempts (woff, ttf, any) extract the URL and attempt a download.
      // - Attempts 1+2: validateFontBuffer returns false (format 'woff'/'ttf' claimed but no magic)
      // - Attempt 3 (any): format assigned as 'unknown'; line 742 returns true → succeeds.
      // Each attempt makes 2 requests (CSS + font download) → 6 mocks total.
      const mockCss = '@font-face { src: url("https://fonts.gstatic.com/font.bin") }';
      const cssOk = { ok: true, text: () => Promise.resolve(mockCss) };
      const fontOk = { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) };
      mockFetch
        .mockResolvedValueOnce(cssOk) // attempt 1 CSS
        .mockResolvedValueOnce(fontOk) // attempt 1 font → format='woff' → validation fails
        .mockResolvedValueOnce(cssOk) // attempt 2 CSS
        .mockResolvedValueOnce(fontOk) // attempt 2 font → format='ttf' → validation fails
        .mockResolvedValueOnce(cssOk) // attempt 3 CSS
        .mockResolvedValueOnce(fontOk); // attempt 3 font → format='unknown' → line 742 → true
      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.source).toBe('google');
    });

    it('extractMessage returns String(error) for non-Error non-string rejections', async () => {
      const okStat = { isFile: () => true, size: 100 } as unknown as Awaited<
        ReturnType<typeof fs.stat>
      >;
      vi.mocked(fs.stat).mockResolvedValue(okStat);
      // Reject readFile with a number — not Error, not string → String(42) = '42'
      vi.mocked(fs.readFile).mockRejectedValue(42);
      await expect(fetcher.fetchLocalFile('font.ttf')).rejects.toThrow('42');
    });

    it('rate limiter: waits when Google Fonts token bucket is exhausted', async () => {
      vi.useFakeTimers();
      // Advance 2s so the rate limiter bucket is fully refilled (10 tokens)
      await vi.advanceTimersByTimeAsync(2000);

      const css = '@font-face { src: url("https://fonts.gstatic.com/t.woff") }';
      const fontBuf = woffMagic();
      // Prepare 11 CSS + 11 font mock responses
      // Use mockImplementation to handle concurrent requests correctly by URL
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('css2')) {
          return { ok: true, text: () => Promise.resolve(css) };
        }
        return { ok: true, arrayBuffer: () => Promise.resolve(fontBuf) };
      });

      // Launch 11 concurrent fetchGoogleFont calls — 11th will hit the rate limiter wait path
      const promises = Array.from({ length: 11 }, () => fetcher.fetchGoogleFont('Test'));

      // Advance 200ms: fires the rate limiter's ~100ms sleep AND any per-request timeouts
      await vi.advanceTimersByTimeAsync(200);

      await Promise.all(promises);
      vi.useRealTimers();
    });

    it('fetchWithRetry calls sleep between attempts', async () => {
      // Use maxRetries:2 so retry loop reaches sleep(); use fake timers to skip actual delay.
      // Provide a synchronous dnsResolver so DNS check doesn't hit real network under fake timers.
      vi.useFakeTimers();
      const retryFetcher = new FontFetcher({
        maxRetries: 2,
        timeout: 100,
        dnsResolver: () => Promise.resolve('1.1.1.1'),
      });

      mockFetch.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });

      const fetchPromise = retryFetcher.fetchFromUrl('https://example.com/font.ttf');
      // Advance past the retry sleep delay (RETRY_DELAY_BASE=1000ms * 2^0=1000ms)
      await vi.advanceTimersByTimeAsync(2000);
      await fetchPromise;
      vi.useRealTimers();
    });

    it('preferTTF: reorders attempts so TTF UA is tried first', async () => {
      const ttfMagic = new Uint8Array([0x00, 0x01, 0x00, 0x00]); // TTF magic bytes
      const mockCss =
        '@font-face { src: url("https://fonts.gstatic.com/t.ttf") format("truetype") }';
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(mockCss),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(ttfMagic.buffer),
        });
      const result = await fetcher.fetchGoogleFont('Roboto', { preferTTF: true });
      expect(result.format).toBe('ttf');
      // First call should use the Android UA (TTF-preferring)
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Check the User-Agent header of the first request
      // biome-ignore lint/suspicious/noExplicitAny: mock call arguments are untyped
      const firstCallUA = (mockFetch.mock.calls[0][1] as any)?.headers?.['User-Agent'];
      expect(firstCallUA).toContain('Android');
    });
  });
});
