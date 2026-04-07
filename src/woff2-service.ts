/**
 * WOFF2 decompression service.
 * Lazy-loaded to avoid overhead when not needed.
 */

// We use dynamic import for wawoff2 to avoid pre-loading WASM.
let woff2Module: typeof import('wawoff2') | null = null;

async function getWoff2() {
  if (!woff2Module) {
    // wawoff2 uses CommonJS/ESM hybrid, we'll try standard import
    woff2Module = await import('wawoff2');
  }
  return woff2Module;
}

export interface DecompressionResult {
  buffer: Buffer;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  processingTimeMs: number;
}

/**
 * Decompresses a WOFF2 buffer to TTF/OTF.
 * Includes safety checks for input/output size.
 */
export async function decompressWoff2(
  woff2Buffer: Buffer,
  options: {
    maxOutputSize?: number; // Safety limit (default: 50MB)
  } = {},
): Promise<DecompressionResult> {
  const startTime = Date.now();
  const maxOutputSize = options.maxOutputSize ?? 50 * 1024 * 1024;

  // Input safety check
  if (woff2Buffer.length > 20 * 1024 * 1024) {
    throw new Error(
      `WOFF2 input too large: ${(woff2Buffer.length / 1024 / 1024).toFixed(1)}MB (max: 20MB)`,
    );
  }

  const { decompress } = await getWoff2();

  let ttfData: Uint8Array;
  try {
    ttfData = await decompress(woff2Buffer);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`WOFF2 decompression failed: ${msg}. File may be corrupted.`);
  }

  const ttfBuffer = Buffer.from(ttfData);

  // Validate output size
  if (ttfBuffer.length > maxOutputSize) {
    throw new Error(
      `Decompressed font exceeds max size: ${(ttfBuffer.length / 1024 / 1024).toFixed(1)}MB`,
    );
  }

  // Verify output format
  const { detectFontFormat } = await import('./font-format.js');
  const outputFormat = detectFontFormat(ttfBuffer);
  if (outputFormat !== 'ttf' && outputFormat !== 'otf') {
    throw new Error(`WOFF2 decompression produced invalid output format: ${outputFormat}`);
  }

  const processingTimeMs = Date.now() - startTime;

  return {
    buffer: ttfBuffer,
    originalSize: ttfBuffer.length,
    compressedSize: woff2Buffer.length,
    ratio: 1 - woff2Buffer.length / ttfBuffer.length,
    processingTimeMs,
  };
}
