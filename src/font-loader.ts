/**
 * Unified font loader - abstracts format differences.
 * Orchestrates detection and decompression.
 */

import { detectFontFormat, getFormatErrorMessage, isSupportedFormat } from './font-format.js';
import { decompressWoff2 } from './woff2-service.js';

/**
 * Result of the unified font loading process.
 */
export interface LoadedFont {
  /** The normalized font binary (guaranteed to be ttf/otf upon success) */
  buffer: Buffer;
  /** Normalized font format ('ttf' or 'otf') */
  format: 'ttf' | 'otf';
  /** Original format before any conversion */
  originalFormat: 'ttf' | 'otf' | 'woff2';
  /** Whether the font was decompressed/converted */
  wasConverted: boolean;
  /** Optional conversion statistics */
  stats?: {
    compressionRatio: number;
    decompressionTimeMs: number;
  };
}

/**
 * Loads a font from a buffer, identifying and decompressing it if necessary.
 * Ensures the output is always a TrueType or OpenType font.
 */
export async function loadFont(
  buffer: Buffer,
  options: {
    verbose?: boolean;
    sourceHint?: string; // For better error messages
  } = {},
): Promise<LoadedFont> {
  const format = detectFontFormat(buffer);

  if (!isSupportedFormat(format)) {
    const hint = options.sourceHint ? ` (${options.sourceHint})` : '';
    throw new Error(`Unsupported font format${hint}: ${getFormatErrorMessage(format)}`);
  }

  // TTF/OTF: Pass-through
  if (format === 'ttf' || format === 'otf') {
    return {
      buffer,
      format,
      originalFormat: format,
      wasConverted: false,
    };
  }

  /* v8 ignore start */
  if (format !== 'woff2') {
    throw new Error(`Unexpected font format: ${format}`);
  }
  /* v8 ignore stop */

  // WOFF2: Decompress to TTF
  if (options.verbose) {
    console.log('[FontLoader] Decompressing WOFF2...');
  }

  const result = await decompressWoff2(buffer);

  if (options.verbose) {
    const ratio = (result.ratio * 100).toFixed(1);
    console.log(
      `[FontLoader] Decompressed: ${(result.compressedSize / 1024).toFixed(1)}KB -> ` +
        `${(result.originalSize / 1024).toFixed(1)}KB ` +
        `(${ratio}% reduction, ${result.processingTimeMs.toFixed(1)}ms)`,
    );
  }

  return {
    buffer: result.buffer,
    format: detectFontFormat(result.buffer) as 'ttf' | 'otf',
    originalFormat: 'woff2',
    wasConverted: true,
    stats: {
      compressionRatio: result.ratio,
      decompressionTimeMs: result.processingTimeMs,
    },
  };
}
