import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FontFetcher, { googleFontsRateLimiter } from '../src/font-fetcher.js';
import type { FontSource } from '../src/types.js';

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
  statSync: vi.fn(),
}));

// Mock DNS resolution via constructor instead of global mock for better ESM reliability
const mockDnsResolver = vi.fn().mockResolvedValue('1.1.1.1');

// Helper type to access private FontFetcher methods in tests
type FontFetcherPrivate = {
  detectSourceType(source: FontSource | { byteLength: number }): Promise<string>;
  extractLatinFontUrl(css: string, format: 'woff' | 'ttf' | 'any'): string | null;
  extractFontNameFromUrl(url: string): string;
  makeRequest(
    url: string,
    options?: { userAgent?: string; signal?: AbortSignal },
  ): Promise<Response>;
  validateUrlSecurity(url: URL): void;
  sleep(ms: number): Promise<void>;
};

const priv = (f: FontFetcher) => f as unknown as FontFetcherPrivate;

// Typed mock fetch helpers
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// TTF magic-byte buffer for font format tests
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
    // 30s timeout is default and safe for mocks
    fetcher = new FontFetcher({
      timeout: 30000,
      maxRetries: 1,
      dnsResolver: mockDnsResolver,
      verbose: false,
    });

    // Completely reset the fetch mock implementation and history
    vi.restoreAllMocks();
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => ({
      ok: true,
      arrayBuffer: () => Promise.resolve(ttfMagic()),
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    }));

    vi.useRealTimers();
    // Disable rate limiter for functional tests to avoid flakiness/timeouts
    vi.spyOn(googleFontsRateLimiter, 'acquire').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    mockFetch.mockReset();
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

    it('should detect local files', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
      } as unknown as import('node:fs').Stats);
      expect(await priv(fetcher).detectSourceType('./font.ttf')).toBe('local');
    });

    it('should handle non-file local paths (directory)', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => false,
        isDirectory: () => true,
      } as unknown as import('node:fs').Stats);
      await expect(priv(fetcher).detectSourceType('./subdir')).rejects.toThrow('is a directory');
    });

    it('should handle missing local paths', async () => {
      const err = new Error('ENOENT');
      (err as unknown as { code: string }).code = 'ENOENT';
      vi.mocked(fs.stat).mockRejectedValue(err);
      await expect(priv(fetcher).detectSourceType('./ghost.ttf')).rejects.toThrow('File not found');
    });

    it('should return unknown for other strings', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
      expect(await priv(fetcher).detectSourceType('???')).toBe('unknown');
    });
  });

  describe('fetch methods', () => {
    it('should handle Buffer input', async () => {
      const buffer = Buffer.from(ttfMagic());
      const result = await fetcher.fetch(buffer);
      expect(result.buffer.toString()).toBe(buffer.toString());
      expect(result.source).toBe('buffer');
      expect(result.format).toBe('ttf');
    });

    it('should handle Uint8Array input', async () => {
      const arr = new Uint8Array(ttfMagic());
      const result = await fetcher.fetch(arr as unknown as FontSource);
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.source).toBe('buffer');
      expect(result.format).toBe('ttf');
    });

    it('protectBuffer: prevents mutation of returned buffer in development', async () => {
      const arr = new Uint8Array(ttfMagic());
      const result = await fetcher.fetch(arr as unknown as FontSource);

      expect(() => result.buffer.write('X')).toThrow(/Cannot mutate cached font buffer/);
      expect(() => result.buffer.fill(0)).toThrow(/Cannot mutate cached font buffer/);
    });
  });

  describe('fetchGoogleFont', () => {
    it('should fetch from Google Fonts', async () => {
      const mockCss = '@font-face { src: url("https://fonts.gstatic.com/t.ttf") }';
      mockFetch.mockReset();
      // Provide valid mock responses for all attempts
      mockFetch.mockImplementation(async () => ({
        ok: true,
        text: () => Promise.resolve(mockCss),
        arrayBuffer: () => Promise.resolve(ttfMagic()),
      }));

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.name).toBe('Roboto');
      expect(result.source).toBe('google');
      expect(result.format).toBe('ttf');
    });

    it('should handle missing font URL in CSS', async () => {
      mockFetch.mockReset();
      mockFetch.mockImplementation(async () => ({
        ok: true,
        text: () => Promise.resolve(''),
        arrayBuffer: () => Promise.resolve(ttfMagic()),
      }));
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow(/No .* font URL found/);
    });
  });

  describe('fetchFromUrl', () => {
    it('should fetch from a URL', async () => {
      const result = await fetcher.fetchFromUrl('https://example.com/MyFont.ttf');
      expect(result.name).toBe('MyFont');
      expect(result.source).toBe('url');
      expect(result.format).toBe('ttf');
    });

    it('should handle HTTP errors', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      await expect(fetcher.fetchFromUrl('https://example.com/404.ttf')).rejects.toThrow('HTTP 404');
    });

    it('should reject file:// protocol', async () => {
      await expect(fetcher.fetchFromUrl('file:///etc/passwd')).rejects.toThrow('not allowed');
    });
  });

  describe('fetchLocalFile', () => {
    const okStat = {
      isFile: () => true,
      size: 100,
    } as unknown as import('node:fs').Stats;

    it('should read local file', async () => {
      const buffer = Buffer.from(ttfMagic());
      vi.mocked(fs.stat).mockResolvedValue(okStat);
      vi.mocked(fs.readFile).mockResolvedValue(buffer);

      const result = await fetcher.fetchLocalFile('test.ttf');
      expect(result.buffer).toEqual(buffer);
      expect(result.name).toBe('test');
      expect(result.source).toBe('local');
    });

    it('should enforce file size limit', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 25 * 1024 * 1024,
      } as unknown as import('node:fs').Stats);
      const smallFetcher = new FontFetcher({ maxDownloadSize: 1024, maxRetries: 1 });
      await expect(smallFetcher.fetchLocalFile('huge.ttf')).rejects.toThrow('too large');
    });
  });

  describe('makeRequest', () => {
    it('should handle timeout', async () => {
      const shortTimeoutFetcher = new FontFetcher({ timeout: 1, dnsResolver: mockDnsResolver });
      mockFetch.mockImplementation(
        (_url, init) =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => resolve({ ok: true } as Response), 100);
            init?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timeout);
                reject(init.signal.reason);
              },
              { once: true },
            );
          }),
      );

      await expect(priv(shortTimeoutFetcher).makeRequest('http://ex.com')).rejects.toThrow(
        /Request timed out/,
      );
    });

    it('fetchWithRetry: retries on 500 error and then fails', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Error' });
      const retryFetcher = new FontFetcher({
        maxRetries: 2,
        verbose: false,
        dnsResolver: mockDnsResolver,
      });
      vi.spyOn(priv(retryFetcher), 'sleep').mockResolvedValue(undefined);

      await expect(retryFetcher.fetchFromUrl('https://example.com/font.ttf')).rejects.toThrow(
        'Failed after 2 attempts',
      );
    });
  });

  describe('SSRF protection', () => {
    it('should block private IP 192.168.x.x', async () => {
      mockDnsResolver.mockResolvedValueOnce('192.168.1.1');
      await expect(fetcher.fetchFromUrl('http://myserver/font.ttf')).rejects.toThrow('blocked');
    });
  });

  describe('caching and deduplication', () => {
    it('fetch() deduplicates concurrent identical requests', async () => {
      const spy = vi.spyOn(fetcher, 'fetchGoogleFont').mockResolvedValue({
        buffer: Buffer.from(ttfMagic()),
        name: 'Roboto',
        source: 'google',
        format: 'ttf',
      });

      await Promise.all([fetcher.fetch('Roboto'), fetcher.fetch('Roboto')]);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('cancel() propagates AbortSignal', async () => {
      let resolveFetch!: (res: unknown) => void;
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );

      const fetchPromise = fetcher.fetch('Roboto');
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

      const [_url, init] = mockFetch.mock.calls[0];
      fetcher.cancel('Roboto');
      expect(init.signal.aborted).toBe(true);

      resolveFetch({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) });
      await fetchPromise.catch(() => {});
    });
  });

  describe('coverage gaps', () => {
    it('extractMessage returns String(error) for non-Error non-string rejections', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 100,
      } as unknown as import('node:fs').Stats);
      vi.mocked(fs.readFile).mockRejectedValue(42);
      await expect(fetcher.fetchLocalFile('font.ttf')).rejects.toThrow('42');
    });
  });
});
