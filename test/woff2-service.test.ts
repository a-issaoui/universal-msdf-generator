import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as fontFormat from '../src/font-format.js';
import { decompressWoff2 } from '../src/woff2-service.js';

// Mock wawoff2
vi.mock('wawoff2', () => ({
  decompress: vi.fn(),
}));

// Mock font-format
vi.mock('../src/font-format.js', async () => {
  const actual = await vi.importActual<typeof fontFormat>('../src/font-format.js');
  return {
    ...actual,
    detectFontFormat: vi.fn(),
  };
});

describe('WOFF2 Decompression Service', () => {
  const mockWoff2Buffer = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
  const mockTtfBuffer = Buffer.from([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0]);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('successfully decompresses WOFF2 to TTF', async () => {
    const wawoff2 = await import('wawoff2');
    vi.mocked(wawoff2.decompress).mockResolvedValue(new Uint8Array(mockTtfBuffer));
    vi.mocked(fontFormat.detectFontFormat).mockReturnValue('ttf');

    const result = await decompressWoff2(mockWoff2Buffer);

    expect(result.buffer).toEqual(mockTtfBuffer);
    expect(result.originalSize).toBe(mockTtfBuffer.length);
    expect(result.compressedSize).toBe(mockWoff2Buffer.length);
    expect(result.ratio).toBeCloseTo(0, 1);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  test('throws error if input is too large', async () => {
    const hugeBuffer = Buffer.alloc(21 * 1024 * 1024);
    await expect(decompressWoff2(hugeBuffer)).rejects.toThrow('WOFF2 input too large');
  });

  test('throws error if wawoff2 fails', async () => {
    const wawoff2 = await import('wawoff2');
    vi.mocked(wawoff2.decompress).mockRejectedValue(new Error('Internal decompression error'));

    await expect(decompressWoff2(mockWoff2Buffer)).rejects.toThrow(
      'WOFF2 decompression failed: Internal decompression error',
    );
  });

  test('throws error if wawoff2 fails with non-Error', async () => {
    vi.mocked((await import('wawoff2')).decompress).mockRejectedValue('String error');

    await expect(decompressWoff2(mockWoff2Buffer)).rejects.toThrow(
      'WOFF2 decompression failed: String error',
    );
  });

  test('throws error if output exceeds maxOutputSize', async () => {
    const wawoff2 = await import('wawoff2');
    // Mock outputting 2MB from a small buffer
    vi.mocked(wawoff2.decompress).mockResolvedValue(new Uint8Array(2 * 1024 * 1024));

    await expect(
      decompressWoff2(mockWoff2Buffer, { maxOutputSize: 1 * 1024 * 1024 }),
    ).rejects.toThrow('Decompressed font exceeds max size');
  });

  test('throws error if decompressed output is not ttf/otf', async () => {
    const wawoff2 = await import('wawoff2');
    vi.mocked(wawoff2.decompress).mockResolvedValue(new Uint8Array(mockTtfBuffer));
    vi.mocked(fontFormat.detectFontFormat).mockReturnValue('unknown');

    await expect(decompressWoff2(mockWoff2Buffer)).rejects.toThrow(
      'WOFF2 decompression produced invalid output format: unknown',
    );
  });
});
