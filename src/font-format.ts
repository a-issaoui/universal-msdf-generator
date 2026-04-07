/**
 * Font format detection and validation.
 * Optimized for zero-dependency header parsing.
 */

export type FontFormat = 'ttf' | 'otf' | 'woff2' | 'woff' | 'eot' | 'unknown';

const SIGNATURES = {
  ttf: Buffer.from([0x00, 0x01, 0x00, 0x00]),
  otf: Buffer.from([0x4f, 0x54, 0x54, 0x4f]), // "OTTO"
  woff2: Buffer.from([0x77, 0x4f, 0x46, 0x32]), // "wOF2"
  woff: Buffer.from([0x77, 0x4f, 0x46, 0x46]), // "wOFF"
  eot: Buffer.from([0x4c, 0x50, 0x46, 0x00]), // At offset 8
} as const;

/**
 * Identifies the font format of a buffer by checking its magic byte signature.
 */
export function detectFontFormat(buffer: Buffer): FontFormat {
  if (buffer.length < 4) return 'unknown';

  const head4 = buffer.subarray(0, 4);

  if (head4.equals(SIGNATURES.ttf)) return 'ttf';
  if (head4.equals(SIGNATURES.otf)) return 'otf';
  if (head4.equals(SIGNATURES.woff2)) return 'woff2';
  if (head4.equals(SIGNATURES.woff)) return 'woff';

  // EOT check at offset 8
  if (buffer.length >= 12 && buffer.subarray(8, 12).equals(SIGNATURES.eot)) {
    return 'eot';
  }

  return 'unknown';
}

/**
 * Identifies the font format from a file extension.
 */
export function detectFormatFromExtension(filename: string): FontFormat {
  const ext = filename.split('.').pop()?.toLowerCase();
  const formatMap: Record<string, FontFormat> = {
    ttf: 'ttf',
    otf: 'otf',
    woff2: 'woff2',
    woff: 'woff',
    eot: 'eot',
  };
  return (ext && formatMap[ext as keyof typeof formatMap]) || 'unknown';
}

/**
 * Returns true if the font format is supported for MSDF generation (natively or via conversion).
 */
export function isSupportedFormat(format: FontFormat): boolean {
  return ['ttf', 'otf', 'woff2'].includes(format);
}

/**
 * Returns a human-readable status message for a given font format.
 */
export function getFormatErrorMessage(format: FontFormat): string {
  const messages: Record<FontFormat, string> = {
    ttf: 'TrueType format (supported)',
    otf: 'OpenType format (supported)',
    woff2: 'WOFF2 format (will decompress)',
    woff: 'WOFF v1 format (not supported - convert to WOFF2 or TTF)',
    eot: 'Embedded OpenType format (not supported - convert to TTF)',
    unknown: 'Unknown format (expected TTF, OTF, or WOFF2)',
  };
  return messages[format];
}
