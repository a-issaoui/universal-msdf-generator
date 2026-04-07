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
      // IE 11 UA: Google Fonts returns WOFF format (not WOFF2) for this UA.
      // msdfgen-wasm supports TTF, OTF, WOFF — but NOT WOFF2 (brotli not bundled).
      userAgent: 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko',
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
        if (ArrayBuffer.isView(source)) {
          // Correctly handles sub-views (e.g. Uint8Array slices from WASM interop)
          return {
            buffer: Buffer.from(source.buffer, source.byteOffset, source.byteLength),
            name: 'buffer-font',
            source: 'buffer',
          };
        }
        // Plain ArrayBuffer
        return {
          buffer: Buffer.from(source as ArrayBuffer),
          name: 'buffer-font',
          source: 'buffer',
        };
      default:
        throw new Error(`Unsupported font source type: ${sourceType}`);
    }
  }

  /**
   * Heuristically determines the type of a given font source.
   *
   * Detection order (explicit beats heuristic):
   * 1. URL object                             → 'url'
   * 2. Buffer / ArrayBuffer / ArrayBufferView → 'buffer'
   * 3. String (delegated to detectStringSource)
   * 4. Anything else                          → 'unknown'
   */
  private async detectSourceType(
    source: FontSource,
  ): Promise<'google' | 'url' | 'local' | 'buffer' | 'unknown'> {
    if (source instanceof URL) return 'url';

    // Binary buffers checked before string so TypedArrays aren't misclassified
    if (Buffer.isBuffer(source) || source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
      return 'buffer';
    }

    if (typeof source === 'string') return this.detectStringSource(source);

    return 'unknown';
  }

  /**
   * Detects the source type for string inputs.
   *
   * Order:
   * a. http(s):// prefix      → 'url'
   * b. Path-like (./, ../, /) → stat → 'local' | 'unknown'
   * c. Google font name heuristic → 'google'
   * d. fs.stat fallback (bare filename with extension) → 'local' | 'unknown'
   */
  private async detectStringSource(
    source: string,
  ): Promise<'google' | 'url' | 'local' | 'unknown'> {
    // a. Explicit remote URL
    if (source.startsWith('http://') || source.startsWith('https://')) return 'url';

    // b. Explicit path-like string — stat first, skip Google heuristic
    const isPathLike =
      source.startsWith('./') || source.startsWith('../') || path.isAbsolute(source);

    if (isPathLike) {
      try {
        const stats = await fs.stat(source);
        if (stats.isFile()) return 'local';
      } catch {
        // Path-like but not a file — treat as unknown rather than Google font
      }
      return 'unknown';
    }

    // c. Google font name heuristic (must contain at least one letter, ≥2 non-space chars)
    if (this.isGoogleFontName(source)) return 'google';

    // d. Fallback: maybe a bare filename with extension, check stat
    try {
      const stats = await fs.stat(source);
      if (stats.isFile()) return 'local';
    } catch {
      // Not a detectable file path — fall through
    }

    return 'unknown';
  }

  /**
   * Returns true when a string looks like a Google Fonts family name.
   * Requires at least one ASCII letter and at least two non-space characters
   * to avoid treating bare numbers, dashes, or whitespace as font names.
   */
  private isGoogleFontName(s: string): boolean {
    return (
      /^[a-zA-Z0-9\s-]+$/.test(s) && // only letters, digits, spaces, hyphens
      !s.includes('.') && // no file extension
      /[a-zA-Z]/.test(s) && // at least one letter
      s.trim().length >= 2 // at least 2 meaningful characters
    );
  }

  /**
   * Retrieves a font binary from the Google Fonts library.
   *
   * Strategy (in order):
   * 1. IE 11 UA → Google returns WOFF (supported by msdfgen-wasm).
   * 2. Old Android UA → Google returns TTF (also supported). Handles newer fonts
   *    like Playwrite that dropped legacy WOFF in favour of WOFF2-only delivery.
   *
   * WOFF2 is never attempted — msdfgen-wasm's WASM binary does not include
   * brotli decompression, so WOFF2 buffers would be rejected at parse time.
   */
  async fetchGoogleFont(fontName: string, options: GoogleFontOptions = {}): Promise<FontData> {
    const { weight = '400', style = 'normal' } = options;

    const ital = style === 'italic' ? '1' : '0';
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      fontName,
    )}:ital,wght@${ital},${weight}&display=swap`;

    // UA → expected format pairs tried in order
    const attempts: Array<{ ua: string; format: string }> = [
      {
        // IE 11 — Google returns WOFF for this UA
        ua: 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko',
        format: 'woff',
      },
      {
        // Android 2.2 — Google returns TTF for this UA (fallback for WOFF2-only fonts)
        ua: 'Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1',
        format: 'ttf',
      },
    ];

    const errors: string[] = [];

    for (const attempt of attempts) {
      try {
        const cssResponse = await this.makeRequest(cssUrl, attempt.ua);
        const css = await cssResponse.text();

        const fontUrl = this.extractLatinFontUrl(css, attempt.format);
        if (!fontUrl) {
          errors.push(`no ${attempt.format} URL in CSS`);
          continue;
        }

        const fontResponse = await this.makeRequest(fontUrl, attempt.ua);
        if (!fontResponse.ok) {
          errors.push(`HTTP ${fontResponse.status}`);
          continue;
        }

        const arrayBuffer = await fontResponse.arrayBuffer();
        return {
          buffer: Buffer.from(arrayBuffer),
          name: fontName,
          weight,
          style,
          format: attempt.format,
          source: 'google',
        };
      } catch (err: unknown) {
        errors.push(this.extractMessage(err));
      }
    }

    throw new Error(
      `Failed to fetch Google Font "${fontName}": no supported format available (${errors.join('; ')})`,
    );
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

    // Apply format preference filter (exact extension match — avoids .woff matching .woff2).
    // When format is 'any', formatFiltered equals parsed (all blocks are candidates).
    // For specific formats, only matching blocks are candidates — prevents downloading
    // an unsupported format (e.g. woff2) when the requested format isn't present.
    const formatFiltered =
      preferredFormat !== 'any'
        ? parsed.filter((b) => {
            const ext = `.${preferredFormat}`;
            const idx = b.url.indexOf(ext);
            if (idx === -1) return false;
            const nextChar = b.url[idx + ext.length];
            return !nextChar || !/[a-z0-9]/i.test(nextChar);
          })
        : parsed;

    const candidates = formatFiltered;
    if (candidates.length === 0) return null;

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
   * Only http: and https: protocols are accepted — file:, ftp:, etc. are rejected
   * to prevent unintended local filesystem access via the fetch API.
   */
  async fetchFromUrl(
    url: string | URL,
    options: { format?: string; name?: string } = {},
  ): Promise<FontData> {
    const urlStr = url instanceof URL ? url.href : url;
    this.assertHttpUrl(urlStr);

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
   * Validates that a URL uses http: or https: protocol.
   * Rejects file:, ftp:, data:, and other schemes that could be misused.
   */
  private assertHttpUrl(urlStr: string): void {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      throw new Error(`Invalid URL: "${urlStr}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `URL protocol "${parsed.protocol}" is not allowed — only http: and https: are supported`,
      );
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
   * When the caller provides a `signal` in FetchOptions, it takes precedence over
   * the internal timeout controller, allowing external cancellation.
   * Uses a finally block to guarantee the timeout handle is always cleared,
   * preventing Node.js from staying alive due to a dangling timer.
   */
  private async makeRequest(url: string, userAgent?: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeout);

    try {
      const response = await fetch(url, {
        signal: this.options.signal ?? controller.signal,
        headers: { 'User-Agent': userAgent ?? (this.options.userAgent as string) },
      });
      return response;
    } catch (error: unknown) {
      throw new Error(`Request failed: ${this.extractMessage(error)}`);
      /* v8 ignore next 3 — finally after throw: branch unreachable via normal return */
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
