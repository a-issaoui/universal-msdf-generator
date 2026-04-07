import { describe, expect, it, vi } from 'vitest';
import { loadFont } from '../src/font-loader.js';

describe('FontLoader', () => {
  it('should include sourceHint in error messages', async () => {
    const invalidBuffer = Buffer.from([0, 0, 0, 0]);
    await expect(loadFont(invalidBuffer, { sourceHint: 'test-hint' })).rejects.toThrow(
      /Unsupported font format \(test-hint\)/,
    );
  });

  it('should omit sourceHint from error message when not provided', async () => {
    const invalidBuffer = Buffer.from([0, 0, 0, 0]);
    // When no sourceHint, the message should NOT contain the "(hint)" parenthetical
    const err = await loadFont(invalidBuffer, {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Unsupported font format:/);
    expect((err as Error).message).not.toMatch(/Unsupported font format \(/);
  });

  it('should log verbose info during WOFF2 decompression', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Mock WOFF2 header
    const mockWoff2Buffer = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);

    // To reach those lines (58-71), we MUST succeed in decompressWoff2.
    // The woff2-service mock is already hoisted in vitest if written at the top,
    // so we can mock it anywhere in the file.
    vi.mock('../src/woff2-service.js', () => ({
      decompressWoff2: vi.fn().mockResolvedValue({
        buffer: Buffer.from([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0]),
        originalSize: 100,
        compressedSize: 50,
        ratio: 0.5,
        processingTimeMs: 10,
      }),
    }));

    await loadFont(mockWoff2Buffer, { verbose: true });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Decompressing WOFF2'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Decompressed'));

    consoleSpy.mockRestore();
  });

  it('should decompress WOFF2 without logging when verbose=false', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mockWoff2Buffer = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);

    await loadFont(mockWoff2Buffer, { verbose: false });

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Decompressing WOFF2'));
    consoleSpy.mockRestore();
  });
});
