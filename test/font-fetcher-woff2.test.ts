import { beforeEach, describe, expect, it, vi } from 'vitest';
import FontFetcher from '../src/font-fetcher.js';
import type { FontData } from '../src/types.js';

// Mock wawoff2
vi.mock('wawoff2', () => ({
  decompress: vi.fn(),
}));

// Mock DNS lookups
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue({ address: '1.1.1.1', family: 4 }),
}));

describe('FontFetcher - WOFF2 Integration', () => {
  const woff2Magic = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
  const ttfMagic = Buffer.from([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0]);

  // Typed mock fetch helper
  const mockFetch = vi.fn();
  global.fetch = mockFetch as unknown as typeof fetch;

  let fetcher: FontFetcher;

  beforeEach(() => {
    fetcher = new FontFetcher({ timeout: 100, maxRetries: 1 });
    vi.clearAllMocks();
  });

  it('automatically decompresses a WOFF2 font from URL', async () => {
    const wawoff2 = await import('wawoff2');
    vi.mocked(wawoff2.decompress).mockResolvedValue(new Uint8Array(ttfMagic));

    // Mock fetch for WOFF2 file
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map([['content-length', String(woff2Magic.length)]]),
      arrayBuffer: () => Promise.resolve(woff2Magic),
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array(woff2Magic) })
            .mockResolvedValueOnce({ done: true }),
          releaseLock: vi.fn(),
        }),
      },
    });

    const result = await fetcher.fetch('https://example.com/font.woff2');

    const fontData = result as unknown as FontData;

    expect(fontData.format).toBe('ttf');
    expect(fontData.originalFormat).toBe('woff2');
    expect(fontData.wasConverted).toBe(true);
    expect(fontData.buffer).toEqual(ttfMagic);
    expect(fontData.metadata?.compressionRatio).toBeDefined();
    expect(fontData.metadata?.decompressionTimeMs).toBeDefined();
  });

  it('fails with human-readable error for unsupported WOFF v1 (magic signature)', async () => {
    const woff1Magic = Buffer.from([0x77, 0x4f, 0x46, 0x46, 0, 0, 0, 0]);

    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map(),
      arrayBuffer: () => Promise.resolve(woff1Magic),
    });

    await expect(fetcher.fetch('https://example.com/font.woff')).rejects.toThrow(
      'Unsupported font format (https://example.com/font.woff): WOFF v1 format',
    );
  });
});
