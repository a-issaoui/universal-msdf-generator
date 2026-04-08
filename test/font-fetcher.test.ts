import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFontNameFromUrl } from '../src/fetcher/url-handler.js';
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
      expect(await fetcher._detectSourceType('Open Sans')).toBe('google');
      expect(await fetcher._detectSourceType('Roboto-Bold')).toBe('google');
    });

    it('should detect URLs', async () => {
      expect(await fetcher._detectSourceType('https://example.com/font.ttf')).toBe('url');
      expect(await fetcher._detectSourceType('http://fonts.com/test.woff')).toBe('url');
    });

    it('should detect local files', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
      } as unknown as import('node:fs').Stats);
      expect(await fetcher._detectSourceType('./font.ttf')).toBe('local');
    });

    it('should handle non-file local paths (directory)', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => false,
        isDirectory: () => true,
      } as unknown as import('node:fs').Stats);
      await expect(fetcher._detectSourceType('./subdir')).rejects.toThrow('is a directory');
    });

    it('should handle missing local paths', async () => {
      const err = new Error('ENOENT');
      (err as unknown as { code: string }).code = 'ENOENT';
      vi.mocked(fs.stat).mockRejectedValue(err);
      await expect(fetcher._detectSourceType('./ghost.ttf')).rejects.toThrow('File not found');
    });

    it('should return unknown for other strings', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
      expect(await fetcher._detectSourceType('???')).toBe('unknown');
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

    it('should fallback from woff2 to woff to ttf', async () => {
      mockFetch.mockReset();
      // Fail woff2 and woff with empty CSS, succeed on ttf
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // woff2
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // woff
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('@font-face { src: url("https://fonts.gstatic.com/t.ttf") }'),
        }) // ttf
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) }); // font

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.source).toBe('google');
      expect(result.format).toBe('ttf');
    });

    it('should prefer TTF when requested', async () => {
      mockFetch.mockReset();
      // First attempt (TTF) succeeds
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              '@font-face { src: url("https://fonts.gstatic.com/t.ttf"); format("truetype"); }',
            ),
        })
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) });

      const result = await fetcher.fetchGoogleFont('Roboto', { preferTTF: true });
      expect(result.source).toBe('google');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('family=Roboto'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining('Nexus One'), // TTF UA
          }),
        }),
      );
    });

    it('should handle complex unicode-range in CSS', async () => {
      mockFetch.mockReset();
      const complexCss = `
            @font-face { 
              font-family: 'Roboto';
              src: url("https://fonts.gstatic.com/korean.woff2");
              unicode-range: U+AC00-D7AF;
            }
            @font-face { 
              font-family: 'Roboto';
              src: url("https://fonts.gstatic.com/latin.woff2");
              unicode-range: U+0000-00FF, U+0131;
            }
          `;
      // fetchGoogleFont tries woff → ttf → any. None of these CSS responses have a matching
      // woff/ttf URL (only woff2), so woff and ttf attempts fail. The 'any' attempt succeeds.
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // woff CSS: no url
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // ttf CSS: no url
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(complexCss) }) // any CSS: has urls
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) }); // font

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.source).toBe('google');
    });

    it('should handle single-point unicode-range', async () => {
      mockFetch.mockReset();
      const singleRangeCss = `
            @font-face { 
              src: url("https://fonts.gstatic.com/a.woff2");
              unicode-range: U+0041;
            }
          `;
      // Again, only a woff2 URL — woff and ttf attempts fail, 'any' succeeds.
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // woff CSS: no url
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // ttf CSS: no url
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(singleRangeCss) }) // any CSS
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) }); // font

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.source).toBe('google');
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

    it('should block unsafe ports (e.g. 22)', async () => {
      await expect(fetcher.fetchFromUrl('http://example.com:22/font.ttf')).rejects.toThrow(
        'port 22 is blocked',
      );
    });

    it('should handle DNS resolution failures', async () => {
      mockDnsResolver.mockRejectedValueOnce(new Error('NXDOMAIN'));
      await expect(fetcher.fetchFromUrl('http://nonexistent.com/font.ttf')).rejects.toThrow(
        'DNS resolution failed',
      );
    });

    it('should block local hostnames (e.g. localhost)', async () => {
      await expect(fetcher.fetchFromUrl('http://localhost/font.ttf')).rejects.toThrow(
        'private/internal address "localhost" is blocked',
      );
    });

    it('should block embedded credentials', async () => {
      await expect(fetcher.fetchFromUrl('http://user:pass@example.com/font.ttf')).rejects.toThrow(
        'embedded credentials are not allowed',
      );
    });

    it('should reject pre-aborted signal', async () => {
      const controller = new AbortController();
      const err = new Error('immediate');
      err.name = 'AbortError';
      controller.abort(err);
      await expect(
        fetcher.fetchFromUrl('https://ex.com/f.ttf', { signal: controller.signal }),
      ).rejects.toThrow('immediate');
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

    it('should reject non-file paths', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => false,
      } as unknown as import('node:fs').Stats);
      await expect(fetcher.fetchLocalFile('dir')).rejects.toThrow(
        'Invalid font source path: expected a file.',
      );
    });

    it('should reject non-existent files', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));
      await expect(fetcher.fetchLocalFile('missing.ttf')).rejects.toThrow(
        'Invalid font source or access denied.',
      );
    });

    it('fetchLocalFile: should prevent path traversal with basePath', async () => {
      const fetcher = new FontFetcher({ basePath: '/secure/dir' });
      const outsidePath = '../../../etc/passwd';
      await expect(fetcher.fetchLocalFile(outsidePath)).rejects.toThrow(
        'Invalid font source path or directory traversal detected',
      );
    });

    it('should enforce file size limit', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 25 * 1024 * 1024,
      } as unknown as import('node:fs').Stats);
      const smallFetcher = new FontFetcher({ maxDownloadSize: 1024, maxRetries: 1 });
      await expect(smallFetcher.fetchLocalFile('huge.ttf')).rejects.toThrow('too large');
    });

    it('should enforce size limit during stream download', async () => {
      const data = new Uint8Array(2000);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      });

      const smallFetcher = new FontFetcher({
        maxDownloadSize: 1000,
        dnsResolver: mockDnsResolver,
      });
      await expect(smallFetcher.fetchFromUrl('https://ex.com/big.ttf')).rejects.toThrow(
        /exceeds maximum allowed size/,
      );
    });

    it('should enforce size limit during arrayBuffer download', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2000)),
      });

      const smallFetcher = new FontFetcher({
        maxDownloadSize: 1000,
        dnsResolver: mockDnsResolver,
      });
      await expect(smallFetcher.fetchFromUrl('https://ex.com/big.ttf')).rejects.toThrow(
        /exceeds maximum allowed size/,
      );
    });

    it('should enforce size limit from content-length header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-length', '2000']]),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });

      const smallFetcher = new FontFetcher({
        maxDownloadSize: 1000,
        dnsResolver: mockDnsResolver,
      });
      await expect(smallFetcher.fetchFromUrl('https://ex.com/big.ttf')).rejects.toThrow(
        /Content-Length 2000 exceeds maximum allowed size/,
      );
    });

    it('should fallback to readArrayBuffer if body is missing', async () => {
      const buf = ttfMagic();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: null,
        arrayBuffer: () => Promise.resolve(buf),
      });

      const result = await fetcher.fetchFromUrl('https://ex.com/font.ttf');
      expect(result.buffer).toEqual(Buffer.from(buf));
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

      await expect(shortTimeoutFetcher.networkClient.makeRequest('http://ex.com')).rejects.toThrow(
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
      vi.spyOn(retryFetcher.networkClient, 'sleep').mockResolvedValue(undefined);

      await expect(retryFetcher.fetchFromUrl('https://example.com/font.ttf')).rejects.toThrow(
        'Failed after 2 attempts',
      );
    });

    it('makeRequest: throws generic error if fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      await expect(fetcher.networkClient.makeRequest('https://ex.com')).rejects.toThrow(
        'Network error',
      );
    });

    it('fetchWithRetry: succeeds on second attempt after 500 error', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) });

      const retryFetcher = new FontFetcher({
        maxRetries: 1,
        verbose: false,
        dnsResolver: mockDnsResolver,
      });
      vi.spyOn(retryFetcher.networkClient, 'sleep').mockResolvedValue(undefined);

      const result = await retryFetcher.fetchFromUrl('https://example.com/font.ttf');
      expect(result.source).toBe('url');
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

  describe('utility methods', () => {
    it('extractFontNameFromUrl: handles invalid URL strings', () => {
      expect(extractFontNameFromUrl('not-a-url')).toBe('unknown-font');
    });

    it('sleep: resolves after timeout', async () => {
      vi.useFakeTimers();
      const sleepPromise = fetcher.networkClient.sleep(100);
      vi.advanceTimersByTime(100);
      await expect(sleepPromise).resolves.toBeUndefined();
      vi.useRealTimers();
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

    it('statForExplicitPath returns unknown for non-file non-dir paths (e.g. block device)', async () => {
      // Simulate a path that is neither a file nor a directory (e.g. a socket/block device)
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => false,
        isDirectory: () => false,
      } as unknown as import('node:fs').Stats);
      // Must use a path that triggers statForExplicitPath (starts with ./ or ../ or is absolute)
      const type = await fetcher._detectSourceType('./device-path');
      expect(type).toBe('unknown');
    });

    it('processBufferSource handles raw ArrayBuffer input (not Buffer, not View)', async () => {
      const rawAb = ttfMagic(); // returns ArrayBuffer
      // Pass as FontSource — the else branch in processBufferSource
      const result = await fetcher.fetch(rawAb as unknown as import('../src/types.js').FontSource);
      expect(result.source).toBe('buffer');
      expect(result.format).toBe('ttf');
    });

    it('findLatinBlock returns false for malformed unicode-range tokens (not single, not range)', async () => {
      mockFetch.mockReset();
      // CSS with a unicode-range token that matches neither single (U+XXXX) nor range (U+XXXX-YYYY)
      const cssMalformed = `
        @font-face {
          src: url("https://fonts.gstatic.com/a.woff2");
          unicode-range: INVALID_TOKEN, U+0041;
        }
      `;
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // woff
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // ttf
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(cssMalformed) }) // any
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) });

      // The malformed token causes findLatinBlock to hit "return false" inside .some()
      // but the second token U+0041 matches, so the block is still found and fetch succeeds.
      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.source).toBe('google');
    });

    it('clearCache: clears the request deduplication cache', async () => {
      const spy = vi.spyOn(fetcher, 'fetchGoogleFont').mockResolvedValue({
        buffer: Buffer.from(ttfMagic()),
        name: 'Roboto',
        source: 'google',
        format: 'ttf',
      });
      await fetcher.fetch('Roboto');
      expect(spy).toHaveBeenCalledTimes(1);
      fetcher.clearCache();
      await fetcher.fetch('Roboto');
      expect(spy).toHaveBeenCalledTimes(2); // Second call not deduplicated
    });

    it('cancel() returns false when no active request found', () => {
      expect(fetcher.cancel('NonExistentFont')).toBe(false);
    });

    it('constructor throws when basePath is not absolute', () => {
      expect(() => new FontFetcher({ basePath: 'relative/path' })).toThrow(
        'basePath must be an absolute path',
      );
    });

    it('fetchGoogleFont: handles pre-aborted signal before rate limiter', async () => {
      const controller = new AbortController();
      controller.abort(new Error('pre-aborted'));
      await expect(
        fetcher.fetchGoogleFont('Roboto', { signal: controller.signal }),
      ).rejects.toThrow('Fetch aborted');
    });

    it('fetchGoogleFont: makes italic request when style=italic', async () => {
      mockFetch.mockReset();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve('@font-face { src: url("https://fonts.gstatic.com/t.woff") }'),
        })
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) });

      const result = await fetcher.fetchGoogleFont('Roboto', { style: 'italic' });
      expect(result.source).toBe('google');
      // Verify the CSS URL contained ital=1
      expect(mockFetch.mock.calls[0][0]).toContain('ital,wght@1,');
    });

    it('detectSourceType: handles URL object input correctly', async () => {
      const urlObj = new URL('https://fonts.gstatic.com/test.ttf');
      const type = await fetcher._detectSourceType(
        urlObj as unknown as import('../src/types.js').FontSource,
      );
      expect(type).toBe('url');
    });

    it('fetch: routes URL object to fetchFromUrl', async () => {
      const urlObj = new URL('https://example.com/Font.ttf');
      const result = await fetcher.fetch(urlObj as unknown as import('../src/types.js').FontSource);
      expect(result.source).toBe('url');
      expect(result.name).toBe('Font');
    });

    it('fetch: routes local file correctly', async () => {
      const buf = Buffer.from(ttfMagic());
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 100,
      } as unknown as import('node:fs').Stats);
      vi.mocked(fs.readFile).mockResolvedValue(buf);
      const result = await fetcher.fetch('./localfont.ttf');
      expect(result.source).toBe('local');
    });

    it('detectStringSource: bare filename that exists on disk is classified as local', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
      } as unknown as import('node:fs').Stats);
      const type = await fetcher._detectSourceType('myfont-custom-name-12345.ttf');
      expect(type).toBe('local');
    });

    it('extractMessage: returns string directly for string errors', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 100,
      } as unknown as import('node:fs').Stats);
      vi.mocked(fs.readFile).mockRejectedValue('string-error');
      await expect(fetcher.fetchLocalFile('font.ttf')).rejects.toThrow('string-error');
    });

    it('extractFontNameFromUrl: returns unknown-font for URL with no filename path', () => {
      // A URL whose pathname basename after removing the extension is empty
      expect(extractFontNameFromUrl('https://example.com/')).toBe('unknown-font');
    });

    it('parseFontFaceBlocks: skips @font-face block without a url() declaration', async () => {
      mockFetch.mockReset();
      // CSS has a block with no url() — should be skipped; second block has url()
      const cssNoUrl = `
        @font-face {
          font-family: 'Roboto';
          /* no src url here */
        }
        @font-face {
          src: url("https://fonts.gstatic.com/t.woff");
        }
      `;
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(cssNoUrl) }) // woff
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) });

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.source).toBe('google');
    });

    it('parseFontFaceBlocks: handles nested braces in @font-face block', async () => {
      mockFetch.mockReset();
      const cssNested = `@font-face { font-variation-settings: { axis: 0 }; src: url("https://fonts.gstatic.com/t.woff"); }`;
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(cssNested) }) // woff
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(ttfMagic()) });

      const result = await fetcher.fetchGoogleFont('Roboto');
      expect(result.source).toBe('google');
    });

    it('fetchLocalFile: throws when signal is already aborted before return', async () => {
      const buf = Buffer.from(ttfMagic());
      const controller = new AbortController();
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 100,
      } as unknown as import('node:fs').Stats);
      vi.mocked(fs.readFile).mockImplementation(async () => {
        controller.abort(new Error('aborted-mid-read'));
        return buf;
      });
      await expect(
        fetcher.fetchLocalFile('font.ttf', { signal: controller.signal }),
      ).rejects.toThrow('aborted-mid-read');
    });

    it('generateCacheKey: handles URL object source', async () => {
      const urlObj = new URL('https://example.com/Font.ttf');
      const spy = vi.spyOn(fetcher, 'fetchFromUrl').mockResolvedValue({
        buffer: Buffer.from(ttfMagic()),
        name: 'Font',
        source: 'url',
        format: 'ttf',
      });
      await fetcher.fetch(urlObj as unknown as import('../src/types.js').FontSource);
      expect(spy).toHaveBeenCalled();
    });

    it('generateCacheKey: handles GoogleFontOptions for cache key differentiation', async () => {
      const spy = vi.spyOn(fetcher, 'fetchGoogleFont').mockResolvedValue({
        buffer: Buffer.from(ttfMagic()),
        name: 'Roboto',
        source: 'google',
        format: 'ttf',
      });
      // Different googleOptions → different cache keys → two calls
      await fetcher.fetch('Roboto', { weight: '400' });
      await fetcher.fetch('Roboto', { weight: '700' });
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('RateLimiter: acquire and refill work correctly', async () => {
      const { RateLimiter } = await import('../src/font-fetcher.js');
      // Instantiate a fresh rate limiter to bypass the global spy
      const limiter = new RateLimiter(2, 100);

      expect(Math.floor(limiter.tokens)).toBe(2);
      await limiter.acquire(); // Consumes 1
      expect(Math.floor(limiter.tokens)).toBe(1);
      await limiter.acquire(); // Consumes 1
      expect(Math.floor(limiter.tokens)).toBe(0);

      // Attempting to acquire when 0 should wait and refill
      const start = Date.now();
      await limiter.acquire();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(50); // It should wait for refill
    });

    it('fetchGoogleFont: re-throws AbortError from attemptGoogleFontFetch', async () => {
      mockFetch.mockReset();
      const abortErr = new Error('abort-in-css-fetch');
      abortErr.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortErr);
      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow('abort-in-css-fetch');
    });

    it('fetchLocalFile: throws default abort reason when signal is aborted with undefined reason', async () => {
      const signal = { aborted: true, reason: undefined } as unknown as AbortSignal;
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 100,
      } as unknown as import('node:fs').Stats);
      vi.mocked(fs.readFile).mockImplementation(async () => Buffer.from(ttfMagic()));
      await expect(fetcher.fetchLocalFile('font.ttf', { signal })).rejects.toThrow('Fetch aborted');
    });

    it('fetchWithRetry: wraps non-Error objects correctly', async () => {
      // makeRequest throws a standard non-Error if global fetch does something weird or we intercept it
      // Force it by intercepting attemptGoogleFontFetch's underlying fetch via mockFetch
      mockFetch.mockReset();
      mockFetch.mockRejectedValue('primitive-failure'); // Not an instance of Error
      vi.spyOn(fetcher.networkClient, 'sleep').mockResolvedValue(undefined);

      const result = fetcher.fetchGoogleFont('Roboto');
      await expect(result).rejects.toThrow('Failed to fetch Google Font'); // Final wrap includes inner msg
    });

    it('fetchWithRetry: reaches the maxRetries limit and throws final error', async () => {
      // Decrease maxRetries to make the test faster
      const fastFetcher = new FontFetcher({ maxRetries: 1 });
      mockFetch.mockReset();
      // Retryable errors: e.g. ECONNRESET or generic "Failed to fetch"
      mockFetch.mockRejectedValue(new Error('Transient network error'));

      // Wait for it to fail after 1 retry
      await expect(fastFetcher.fetchFromUrl(new URL('https://ex.com/a.ttf'))).rejects.toThrow(
        /Failed after 1 attempts: Transient network error/,
      );
    });

    it('makeRequest: handles external abort before fetch is called with no reason', async () => {
      const signal = {
        aborted: true,
        reason: undefined,
        addEventListener: vi.fn(),
      } as unknown as AbortSignal;

      await expect(
        fetcher.networkClient.makeRequest('https://example.com/font.ttf', { signal }),
      ).rejects.toThrow('Request aborted by external signal');
    });

    it('GoogleFontsHandler._extractMessage: covers string and non-Error/string branches', async () => {
      // Spy on networkClient.fetchWithRetry so rejections bypass Error wrapping in fetchWithRetry.
      // woff + ttf → string (line 208), any → number (line 209)
      vi.spyOn(fetcher.networkClient, 'fetchWithRetry')
        .mockRejectedValueOnce('css-string-error') // woff attempt: string → line 208
        .mockRejectedValueOnce('css-string-error') // ttf attempt: string → line 208
        .mockRejectedValueOnce(42); // any attempt: number → line 209

      await expect(fetcher.fetchGoogleFont('Roboto')).rejects.toThrow(
        'Failed to fetch Google Font',
      );
    });

    it('LocalFileHandler._resolvePath: returns resolved path when basePath is set and path is valid', async () => {
      const secureFetcher = new FontFetcher({ basePath: '/secure/dir' });
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 100,
      } as unknown as import('node:fs').Stats);
      vi.mocked(fs.readFile).mockImplementation(async () => Buffer.from(ttfMagic()));

      const result = await secureFetcher.fetchLocalFile('fonts/myfont.ttf');
      expect(result.source).toBe('local');
      // Path was resolved relative to basePath
      expect(result.path).toBe('/secure/dir/fonts/myfont.ttf');
    });

    it('NetworkClient: uses default values when constructed with no options', async () => {
      const { NetworkClient, DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES, MAX_DOWNLOAD_SIZE } =
        await import('../src/fetcher/network.js');
      const client = new NetworkClient();
      expect(client.timeout).toBe(DEFAULT_TIMEOUT);
      expect(client.maxRetries).toBe(DEFAULT_MAX_RETRIES);
      expect(client.maxDownloadSize).toBe(MAX_DOWNLOAD_SIZE);
      expect(client.verbose).toBe(true);
    });

    it('extractMessage: covers all three error type branches directly', async () => {
      const { extractMessage } = await import('../src/fetcher/network.js');
      expect(extractMessage(new Error('err-msg'))).toBe('err-msg');
      expect(extractMessage('string-err')).toBe('string-err');
      expect(extractMessage(42)).toBe('42');
    });
  });
});
