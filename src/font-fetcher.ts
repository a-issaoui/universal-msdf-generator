import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import type { FetchOptions, FontData, FontSource, GoogleFontOptions } from './types.js';

/**
 * Robust font retrieval engine.
 * Handles acquisition of font binaries from Google Fonts, remote URLs, and the local filesystem.
 */
class FontFetcher {
  private options: FetchOptions;

  /**
   * @param options - Default configuration for fetch requests.
   */
  constructor(options: FetchOptions = {}) {
    this.options = {
      timeout: 30000,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...options,
    };
  }

  /**
   * Primary entry point for fetching font data.
   * Automatically detects the source type and routes accordingly.
   */
  async fetch(source: FontSource): Promise<FontData> {
    const sourceType = await this.detectSourceType(source);

    switch (sourceType) {
      case 'google':
        return this.fetchGoogleFont(source as string);
      case 'url':
        return this.fetchFromUrl(source instanceof URL ? source : String(source));
      case 'local':
        return this.fetchLocalFile(String(source));
      case 'buffer':
        if (Buffer.isBuffer(source)) {
          return { buffer: source, name: 'buffer-font', source: 'buffer' };
        }
        return {
          buffer: Buffer.from(source as unknown as ArrayBuffer),
          name: 'buffer-font',
          source: 'buffer',
        };
      default:
        throw new Error(`Unsupported font source type: ${sourceType}`);
    }
  }

  /**
   * Heuristically determines the type of a given font source.
   */
  private async detectSourceType(
    source: FontSource,
  ): Promise<'google' | 'url' | 'local' | 'buffer' | 'unknown'> {
    if (source instanceof URL) return 'url';

    if (typeof source === 'string') {
      // Google Font name: only letters, digits, spaces, hyphens — no file extension
      if (/^[a-zA-Z0-9\s-]+$/.test(source) && !source.includes('.')) return 'google';

      if (source.startsWith('http://') || source.startsWith('https://')) return 'url';

      try {
        const stats = await fs.stat(source);
        if (stats.isFile()) return 'local';
      } catch {
        // Not a detectable file path — fall through
      }
    }

    if (
      Buffer.isBuffer(source) ||
      source instanceof ArrayBuffer ||
      (typeof source === 'object' && source !== null && 'byteLength' in (source as object))
    ) {
      return 'buffer';
    }

    return 'unknown';
  }

  /**
   * Retrieves a font binary from the Google Fonts library.
   *
   * Improvement over the previous version: the Google Fonts CSS v2 response contains
   * multiple @font-face blocks — one per Unicode range subset (cyrillic-ext, latin-ext,
   * latin, etc.). The old code returned the first URL it found, which is almost always
   * the "cyrillic-ext" block. This version parses each @font-face block individually
   * and prefers the block whose unicode-range descriptor contains the Basic Latin range
   * (U+0020–U+007E), falling back to the first block when no explicit Latin range is found.
   */
  async fetchGoogleFont(fontName: string, options: GoogleFontOptions = {}): Promise<FontData> {
    const { weight = '400', style = 'normal', format = 'woff2' } = options;

    const ital = style === 'italic' ? '1' : '0';
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      fontName,
    )}:ital,wght@${ital},${weight}&display=swap`;

    try {
      const cssResponse = await this.makeRequest(cssUrl);
      const css = await cssResponse.text();

      const fontUrl = this.extractLatinFontUrl(css, format);
      if (!fontUrl) {
        throw new Error(`Could not extract font URL for "${fontName}" (format: ${format})`);
      }

      const fontResponse = await this.makeRequest(fontUrl);
      if (!fontResponse.ok) {
        throw new Error(`Font download failed with HTTP ${fontResponse.status}`);
      }
      const arrayBuffer = await fontResponse.arrayBuffer();

      return {
        buffer: Buffer.from(arrayBuffer),
        name: fontName,
        weight,
        style,
        format,
        source: 'google',
      };
    } catch (error: unknown) {
      throw new Error(`Failed to fetch Google Font "${fontName}": ${this.extractMessage(error)}`);
    }
  }

  /**
   * Parses Google Fonts CSS v2 to extract the font URL for the Latin Unicode block.
   *
   * The CSS contains multiple @font-face blocks separated by comments indicating the
   * subset name. Each block has a `unicode-range` descriptor. We split on @font-face,
   * parse each block independently, and prefer the one that covers U+0041 (A — Basic Latin).
   * If none matches, we return the URL from the last block (Google always places the
   * primary Latin block last).
   */
  private extractLatinFontUrl(css: string, preferredFormat: string): string | null {
    // Split into individual @font-face blocks
    const blocks = css.split('@font-face').slice(1);
    if (blocks.length === 0) return null;

    interface FontBlock {
      url: string;
      unicodeRange: string | null;
    }

    const parsed: FontBlock[] = blocks
      .map((block) => {
        const urlMatch = /src:[^;]*url\((['"]?)([^)'"\s]+)\1\)/.exec(block);
        const rangeMatch = /unicode-range\s*:\s*([^;]+);/.exec(block);
        return {
          url: urlMatch ? urlMatch[2] : '',
          unicodeRange: rangeMatch ? rangeMatch[1].trim() : null,
        };
      })
      .filter((b) => b.url.length > 0);

    if (parsed.length === 0) return null;

    // Apply format preference filter
    const formatFiltered =
      preferredFormat !== 'any'
        ? parsed.filter((b) => b.url.includes(`.${preferredFormat}`))
        : parsed;

    const candidates = formatFiltered.length > 0 ? formatFiltered : parsed;

    // Prefer the block that covers U+0041 (Basic Latin) by checking the unicode-range
    // descriptor for a range that spans it.
    const LatinA = 0x0041;
    const latinBlock = candidates.find((b) => {
      if (!b.unicodeRange) return false;
      return b.unicodeRange.split(',').some((segment) => {
        const s = segment.trim();
        // Single codepoint: U+0041
        const single = /^U\+([0-9A-Fa-f]+)$/.exec(s);
        if (single) return parseInt(single[1], 16) === LatinA;
        // Range: U+0020-007E
        const range = /^U\+([0-9A-Fa-f]+)-([0-9A-Fa-f]+)$/.exec(s);
        if (range) {
          const lo = parseInt(range[1], 16);
          const hi = parseInt(range[2], 16);
          return LatinA >= lo && LatinA <= hi;
        }
        return false;
      });
    });

    // Fall back to the last candidate — Google places the primary Latin subset last
    return (latinBlock ?? candidates[candidates.length - 1]).url;
  }

  /**
   * Downloads a font file from a generic remote URL.
   */
  async fetchFromUrl(
    url: string | URL,
    options: { format?: string; name?: string } = {},
  ): Promise<FontData> {
    const urlStr = url instanceof URL ? url.href : url;
    const format = options.format ?? this.detectFormatFromUrl(urlStr);
    const name = options.name ?? this.extractFontNameFromUrl(urlStr);

    try {
      const response = await this.makeRequest(urlStr);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();

      return {
        buffer: Buffer.from(arrayBuffer),
        name: name || 'unknown-font',
        format,
        source: 'url',
        originalUrl: urlStr,
      };
    } catch (error: unknown) {
      throw new Error(`Failed to fetch font from URL: ${this.extractMessage(error)}`);
    }
  }

  /**
   * Reads a font directly from the local disk.
   */
  async fetchLocalFile(
    filePath: string,
    options: { name?: string; format?: string } = {},
  ): Promise<FontData> {
    try {
      const fullPath = path.resolve(filePath);
      const buffer = await fs.readFile(fullPath);
      const name = options.name ?? path.basename(filePath, path.extname(filePath));
      const format = options.format ?? path.extname(filePath).slice(1).toLowerCase();

      return { buffer, name, format, source: 'local', path: fullPath };
    } catch (error: unknown) {
      throw new Error(`Failed to read local font file: ${this.extractMessage(error)}`);
    }
  }

  /**
   * Internal HTTP request helper with timeout safety.
   * Uses a finally block to guarantee the timeout handle is always cleared,
   * preventing Node.js from staying alive due to a dangling timer.
   */
  private async makeRequest(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': this.options.userAgent as string },
      });
      return response;
    } catch (error: unknown) {
      throw new Error(`Request failed: ${this.extractMessage(error)}`);
      /* v8 ignore next 3 */
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Infers font format from the file extension in a URL. */
  private detectFormatFromUrl(url: string): string {
    const formatMap: Record<string, string> = {
      '.ttf': 'ttf',
      '.otf': 'otf',
      '.woff': 'woff',
      '.woff2': 'woff2',
      '.eot': 'eot',
    };
    for (const [ext, fmt] of Object.entries(formatMap)) {
      if (url.toLowerCase().includes(ext)) return fmt;
    }
    return 'unknown';
  }

  /** Infers a friendly font name from the filename portion of a URL. */
  private extractFontNameFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const filename = path.basename(urlObj.pathname);
      return path.basename(filename, path.extname(filename));
    } catch {
      return 'unknown-font';
    }
  }

  /** Universal error message extractor for consistent catch blocks. */
  private extractMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export default FontFetcher;
