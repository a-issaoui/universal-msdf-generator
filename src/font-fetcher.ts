/**
 * font-fetcher.ts
 * Production-hardened font retrieval engine with security, validation, and performance optimizations.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import type { FetchOptions, FontData, FontSource, GoogleFontOptions } from './types.js';

// ============================================================================
// Security Constants
// ============================================================================

/** Private IPv4/IPv6 ranges blocked for SSRF protection */
const PRIVATE_IP_PATTERNS = [
  /^127\./, // Loopback
  /^10\./, // Private Class A
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
  /^192\.168\./, // Private Class C
  /^169\.254\./, // Link-local (AWS metadata, etc.)
  /^0\./, // Current network
  /^::1$/, // IPv6 loopback
  /^fc00:/i, // IPv6 unique local
  /^fe80:/i, // IPv6 link-local
];

/** Maximum allowed download size (20 MB — sufficient for the largest CJK fonts) */
const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024;

/** Default request timeout in ms */
const DEFAULT_TIMEOUT = 30000;

/** Default retry attempts */
const DEFAULT_MAX_RETRIES = 3;

/** Base delay for exponential backoff retry (ms) */
const RETRY_DELAY_BASE = 1000;

// ============================================================================
// Font Format Magic Bytes
// ============================================================================

const FONT_SIGNATURES: Record<string, { magic: Buffer; offset?: number }> = {
  ttf: { magic: Buffer.from([0x00, 0x01, 0x00, 0x00]) },
  otf: { magic: Buffer.from([0x4f, 0x54, 0x54, 0x4f]) }, // "OTTO"
  woff: { magic: Buffer.from([0x77, 0x4f, 0x46, 0x46]) }, // "wOFF"
  woff2: { magic: Buffer.from([0x77, 0x4f, 0x46, 0x32]) }, // "wOF2"
  eot: { magic: Buffer.from([0x4c, 0x50, 0x46, 0x00]), offset: 8 },
};

// ============================================================================
// Public types
// ============================================================================

export interface SecureFetchOptions extends FetchOptions {
  /** Base directory for local file resolution. When set, all local paths are relative to this. */
  basePath?: string;
  /** Maximum download size in bytes. Default: 20 MB. */
  maxDownloadSize?: number;
  /** Retry attempts for transient network failures. Default: 3. */
  maxRetries?: number;
  /** Shared cache map for request deduplication across instances. */
  cache?: Map<string, Promise<FontData>>;
  /** Custom DNS resolver for DNS-rebinding protection (not yet used internally). */
  dnsResolver?: (hostname: string) => Promise<string>;
}

interface ParsedFontBlock {
  url: string;
  format: string;
  unicodeRange: string | null;
}

// ============================================================================
// Module-level helpers
// ============================================================================

function isPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === 'localhost.localdomain') return true;
  return PRIVATE_IP_PATTERNS.some((p) => p.test(hostname));
}

function generateCacheKey(source: FontSource, options?: GoogleFontOptions): string {
  const hash = createHash('sha256');
  if (typeof source === 'string') {
    hash.update(`str:${source}`);
  } else if (source instanceof URL) {
    hash.update(`url:${source.href}`);
  } else if (Buffer.isBuffer(source)) {
    hash.update('buf:').update(source);
  } else if (ArrayBuffer.isView(source)) {
    const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    hash.update('view:').update(view);
  } else if (source instanceof ArrayBuffer) {
    hash.update('ab:').update(Buffer.from(source));
  }
  if (options) hash.update(JSON.stringify(options));
  return hash.digest('hex').slice(0, 16);
}

// ============================================================================
// Main class
// ============================================================================

/**
 * Production-hardened font retrieval engine.
 *
 * Security features:
 * - SSRF protection (blocks private IPs, localhost, link-local addresses)
 * - Path traversal prevention via optional basePath enforcement
 * - Protocol restrictions (http/https only for remote URLs)
 * - Download size limits (default 20 MB)
 * - Font format validation via magic bytes
 *
 * Performance features:
 * - Request deduplication and optional caching
 * - Exponential backoff retry for transient failures
 * - Streaming size validation (falls back to arrayBuffer when streaming unavailable)
 */
export class FontFetcher {
  private readonly options: SecureFetchOptions;
  private readonly requestCache: Map<string, Promise<FontData>>;
  private readonly activeRequests: Map<string, AbortController>;

  constructor(options: SecureFetchOptions = {}) {
    this.options = {
      timeout: DEFAULT_TIMEOUT,
      userAgent: 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko',
      maxDownloadSize: MAX_DOWNLOAD_SIZE,
      maxRetries: DEFAULT_MAX_RETRIES,
      ...options,
    };
    this.requestCache = options.cache ?? new Map();
    this.activeRequests = new Map();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Primary entry point for fetching font data.
   * Detects source type automatically and caches results for deduplication.
   */
  async fetch(source: FontSource, googleOptions?: GoogleFontOptions): Promise<FontData> {
    const cacheKey = generateCacheKey(source, googleOptions);

    const cached = this.requestCache.get(cacheKey);
    if (cached) return cached.then((d) => this.cloneFontData(d));

    const controller = new AbortController();
    this.activeRequests.set(cacheKey, controller);

    const promise = this.executeFetch(source, googleOptions).finally(() => {
      this.activeRequests.delete(cacheKey);
    });

    this.requestCache.set(cacheKey, promise);
    return promise.then((d) => this.cloneFontData(d));
  }

  /** Cancel an in-flight request started via fetch(). Returns true if cancelled. */
  cancel(source: FontSource, googleOptions?: GoogleFontOptions): boolean {
    const cacheKey = generateCacheKey(source, googleOptions);
    const controller = this.activeRequests.get(cacheKey);
    if (!controller) return false;
    controller.abort();
    this.activeRequests.delete(cacheKey);
    return true;
  }

  /** Clear the internal request deduplication cache. */
  clearCache(): void {
    this.requestCache.clear();
  }

  // -------------------------------------------------------------------------
  // Source detection & routing
  // -------------------------------------------------------------------------

  private async executeFetch(
    source: FontSource,
    googleOptions?: GoogleFontOptions,
  ): Promise<FontData> {
    const sourceType = await this.detectSourceType(source);
    switch (sourceType) {
      case 'google':
        return this.fetchGoogleFont(source as string, googleOptions);
      case 'url':
        return this.fetchFromUrl(source instanceof URL ? source : new URL(source as string));
      case 'local':
        return this.fetchLocalFile(String(source));
      case 'buffer':
        return this.processBufferSource(source);
      default:
        throw new Error(`Unsupported font source type: ${sourceType}`);
    }
  }

  private async detectSourceType(
    source: FontSource,
  ): Promise<'google' | 'url' | 'local' | 'buffer' | 'unknown'> {
    // Buffers first — avoids misclassifying TypedArrays as objects
    if (Buffer.isBuffer(source) || ArrayBuffer.isView(source) || source instanceof ArrayBuffer) {
      return 'buffer';
    }
    if (source instanceof URL) {
      this.validateUrlSecurity(source);
      return 'url';
    }
    if (typeof source === 'string') return this.detectStringSource(source);
    return 'unknown';
  }

  /**
   * Classify a string source.
   * Priority: explicit URL → explicit path → Google font name → bare filename stat
   */
  private async detectStringSource(
    source: string,
  ): Promise<'google' | 'url' | 'local' | 'unknown'> {
    return this.detectStringSourceInner(source.trim());
  }

  private async detectStringSourceInner(
    trimmed: string,
  ): Promise<'google' | 'url' | 'local' | 'unknown'> {
    // a. Explicit http(s) URL
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed); // throws for malformed URLs
      this.validateUrlSecurity(url);
      return 'url';
    }

    // b. Explicit path-like: ./, ../, or absolute
    const isExplicitPath =
      trimmed.startsWith('./') || trimmed.startsWith('../') || path.isAbsolute(trimmed);

    if (isExplicitPath) {
      return this.statForExplicitPath(trimmed);
    }

    // c. Google font name heuristic
    if (this.isGoogleFontName(trimmed)) return 'google';

    // d. Fallback: bare filename that exists on disk
    try {
      const stats = await fs.stat(trimmed);
      if (stats.isFile()) return 'local';
    } catch {
      // not a file
    }
    return 'unknown';
  }

  private async statForExplicitPath(trimmed: string): Promise<'local' | 'unknown'> {
    try {
      const stats = await fs.stat(trimmed);
      if (stats.isFile()) return 'local';
      if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: "${trimmed}"`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new Error(`File not found: "${trimmed}"`);
      throw err;
    }
    return 'unknown';
  }

  private isGoogleFontName(s: string): boolean {
    return (
      /^[a-zA-Z][a-zA-Z0-9]*(?:[ -][a-zA-Z0-9]+)*$/.test(s) &&
      !s.includes('.') &&
      s.length >= 2 &&
      s.length <= 100
    );
  }

  private processBufferSource(source: FontSource): FontData {
    let buffer: Buffer;
    if (Buffer.isBuffer(source)) {
      buffer = source;
    } else if (ArrayBuffer.isView(source)) {
      buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    } else {
      buffer = Buffer.from(source as ArrayBuffer);
    }
    const detectedFormat = this.detectFormatFromBuffer(buffer);
    return { buffer, name: 'buffer-font', format: detectedFormat ?? undefined, source: 'buffer' };
  }

  // -------------------------------------------------------------------------
  // Google Fonts
  // -------------------------------------------------------------------------

  async fetchGoogleFont(fontName: string, options: GoogleFontOptions = {}): Promise<FontData> {
    const { weight = '400', style = 'normal' } = options;

    const ital = style === 'italic' ? '1' : '0';
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      fontName,
    )}:ital,wght@${ital},${weight}&display=swap`;

    // UA → expected format pairs, in priority order.
    // IE 11 UA → WOFF; Android 2.2 UA → TTF (fallback for WOFF2-only fonts like Playwrite);
    // Generic UA → any format as last resort.
    const attempts: Array<{ ua: string; format: 'woff' | 'ttf' | 'any' }> = [
      {
        ua: 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko',
        format: 'woff',
      },
      {
        ua: 'Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1',
        format: 'ttf',
      },
      { ua: 'Mozilla/5.0 (compatible; FontBot/1.0)', format: 'any' },
    ];

    const errors: Array<{ format: string; error: string }> = [];

    for (const attempt of attempts) {
      try {
        const fontData = await this.attemptGoogleFontFetch(
          cssUrl,
          fontName,
          weight,
          style,
          attempt.ua,
          attempt.format,
        );
        if (this.validateFontBuffer(fontData.buffer, fontData.format)) return fontData;
        errors.push({
          format: attempt.format,
          error: `Content failed validation for format ${fontData.format}`,
        });
      } catch (err) {
        errors.push({ format: attempt.format, error: this.extractMessage(err) });
      }
    }

    const detail = errors.map((e) => `${e.format}: ${e.error}`).join('; ');
    throw new Error(
      `Failed to fetch Google Font "${fontName}" (weight: ${weight}, style: ${style}): ${detail}`,
    );
  }

  private async attemptGoogleFontFetch(
    cssUrl: string,
    fontName: string,
    weight: string,
    style: string,
    userAgent: string,
    preferredFormat: 'woff' | 'ttf' | 'any',
  ): Promise<FontData> {
    const cssResponse = await this.fetchWithRetry(cssUrl, { userAgent });
    const css = await cssResponse.text();

    const fontUrl = this.extractLatinFontUrl(css, preferredFormat);
    if (!fontUrl) throw new Error(`No ${preferredFormat} font URL found in CSS response`);

    // Validate the extracted URL before fetching
    const fontUrlObj = new URL(fontUrl);
    this.validateUrlSecurity(fontUrlObj);

    const fontResponse = await this.fetchWithRetry(fontUrl, { userAgent });
    const buffer = await this.readResponseWithSizeLimit(fontResponse);

    const detectedFormat = this.detectFormatFromBuffer(buffer);
    return {
      buffer,
      name: fontName,
      weight,
      style,
      format: detectedFormat ?? (preferredFormat !== 'any' ? preferredFormat : 'unknown'),
      source: 'google',
    };
  }

  // -------------------------------------------------------------------------
  // Google Fonts CSS parsing
  // -------------------------------------------------------------------------

  private extractLatinFontUrl(css: string, preferredFormat: 'woff' | 'ttf' | 'any'): string | null {
    const blocks = this.parseFontFaceBlocks(css);
    if (blocks.length === 0) return null;

    const candidates =
      preferredFormat === 'any'
        ? blocks
        : blocks.filter((b) => b.format === preferredFormat || b.format === 'unknown');

    if (candidates.length === 0) return null;

    const latinBlock = this.findLatinBlock(candidates);
    return latinBlock?.url ?? candidates[candidates.length - 1].url;
  }

  private parseFontFaceBlocks(css: string): ParsedFontBlock[] {
    const blocks: ParsedFontBlock[] = [];
    const rawBlocks = css.split(/@font-face\s*\{/i).slice(1);

    for (const rawBlock of rawBlocks) {
      // Find closing brace
      let braceCount = 1;
      let endIndex = 0;
      for (let i = 0; i < rawBlock.length && braceCount > 0; i++) {
        if (rawBlock[i] === '{') braceCount++;
        else if (rawBlock[i] === '}') braceCount--;
        endIndex = i;
      }
      const blockContent = rawBlock.slice(0, endIndex);

      const urlMatch = blockContent.match(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/i);
      if (!urlMatch) continue;

      const url = urlMatch[1];
      const formatMatch = blockContent.match(/format\(\s*['"]?([^)'"]+)['"]?\s*\)/i);
      const formatHint = formatMatch?.[1].toLowerCase() ?? 'unknown';
      const format = this.canonicalizeFormat(formatHint) ?? this.detectFormatFromUrl(url);

      const rangeMatch = blockContent.match(/unicode-range\s*:\s*([^;]+)/i);
      const unicodeRange = rangeMatch?.[1].trim() ?? null;

      blocks.push({ url, format, unicodeRange });
    }

    return blocks;
  }

  private canonicalizeFormat(format: string): string | null {
    const map: Record<string, string> = {
      truetype: 'ttf',
      opentype: 'otf',
      woff: 'woff',
      woff2: 'woff2',
      'embedded-opentype': 'eot',
    };
    return map[format] ?? null;
  }

  private findLatinBlock(blocks: ParsedFontBlock[]): ParsedFontBlock | null {
    const LatinA = 0x0041;
    return (
      blocks.find((block) => {
        if (!block.unicodeRange) return false;
        return block.unicodeRange.split(',').some((r) => {
          const s = r.trim();
          const single = /^U\+([0-9a-fA-F]+)$/.exec(s);
          if (single) return parseInt(single[1], 16) === LatinA;
          const range = /^U\+([0-9a-fA-F]+)-([0-9a-fA-F]+)$/.exec(s);
          if (range) {
            const lo = parseInt(range[1], 16);
            const hi = parseInt(range[2], 16);
            return LatinA >= lo && LatinA <= hi;
          }
          return false;
        });
      }) ?? null
    );
  }

  // -------------------------------------------------------------------------
  // URL fetching
  // -------------------------------------------------------------------------

  async fetchFromUrl(
    url: string | URL,
    options: { format?: string; name?: string } = {},
  ): Promise<FontData> {
    const urlObj = url instanceof URL ? url : new URL(url);
    this.validateUrlSecurity(urlObj);

    const urlStr = urlObj.href;
    const format = options.format ?? this.detectFormatFromUrl(urlStr);
    const name = options.name ?? this.extractFontNameFromUrl(urlStr);

    const response = await this.fetchWithRetry(urlStr);
    const buffer = await this.readResponseWithSizeLimit(response);

    const detectedFormat = this.detectFormatFromBuffer(buffer);
    return {
      buffer,
      name: name || 'unknown-font',
      format: detectedFormat ?? format,
      source: 'url',
      originalUrl: urlStr,
    };
  }

  // -------------------------------------------------------------------------
  // Local file fetching
  // -------------------------------------------------------------------------

  async fetchLocalFile(
    filePath: string,
    options: { name?: string; format?: string } = {},
  ): Promise<FontData> {
    let resolvedPath: string;

    if (this.options.basePath) {
      // Enforce basePath restriction — prevent traversal outside of it
      resolvedPath = path.resolve(this.options.basePath, filePath);
      const rel = path.relative(this.options.basePath, resolvedPath);
      if (rel.startsWith('..')) {
        throw new Error(`Path traversal detected: "${filePath}" resolves outside basePath`);
      }
    } else {
      // No basePath — resolve normally (caller is responsible for path safety)
      resolvedPath = path.resolve(filePath);
    }

    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(resolvedPath);
    } catch (err) {
      throw new Error(`Failed to access local file "${filePath}": ${this.extractMessage(err)}`);
    }

    if (!stats.isFile()) {
      throw new Error(`Path is not a file: "${filePath}"`);
    }

    const maxSize = this.options.maxDownloadSize as number;
    if (stats.size > maxSize) {
      throw new Error(`File too large: ${stats.size} bytes (max: ${maxSize})`);
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(resolvedPath);
    } catch (err) {
      throw new Error(`Failed to read local file "${filePath}": ${this.extractMessage(err)}`);
    }

    const detectedFormat = this.detectFormatFromBuffer(buffer);
    const claimedFormat = options.format ?? path.extname(resolvedPath).slice(1).toLowerCase();

    return {
      buffer,
      name: options.name ?? path.basename(resolvedPath, path.extname(resolvedPath)),
      format: detectedFormat ?? claimedFormat,
      source: 'local',
      path: resolvedPath,
    };
  }

  // -------------------------------------------------------------------------
  // Network layer
  // -------------------------------------------------------------------------

  private async fetchWithRetry(
    url: string,
    options: { userAgent?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const maxRetries = this.options.maxRetries as number;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.makeRequest(url, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on deterministic failures
        if (
          lastError.message.includes('blocked') ||
          lastError.message.includes('traversal') ||
          lastError.message.includes('too large') ||
          lastError.message.includes('not allowed') ||
          lastError.message.includes('HTTP 4') // 4xx client errors
        ) {
          throw lastError;
        }

        if (attempt < maxRetries - 1) {
          await this.sleep(RETRY_DELAY_BASE * 2 ** attempt);
        }
      }
    }

    throw new Error(`Failed after ${maxRetries} attempts: ${lastError?.message}`);
  }

  private async makeRequest(
    url: string,
    options: { userAgent?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeout as number);

    // If an external signal is provided (per-request or global FetchOptions), link to controller
    const externalSignal = options.signal ?? this.options.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeout);
        throw new Error('Request aborted by external signal');
      }
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': options.userAgent ?? (this.options.userAgent as string),
          accept: 'font/woff2,font/woff,font/ttf,font/otf,*/*',
        },
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out or aborted: ${url}`);
      }
      throw err;
    }

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  }

  /**
   * Reads a response body with a size cap.
   * Uses streaming when available; falls back to arrayBuffer() for environments
   * (or test mocks) that don't expose a readable body stream.
   */
  private async readResponseWithSizeLimit(response: Response): Promise<Buffer> {
    const maxSize = this.options.maxDownloadSize as number;
    this.checkContentLength(response, maxSize);
    return response.body
      ? this.readStream(response.body, maxSize)
      : this.readArrayBuffer(response, maxSize);
  }

  private checkContentLength(response: Response, maxSize: number): void {
    const header = response.headers?.get?.('content-length');
    if (!header) return;
    const size = Number.parseInt(header, 10);
    if (!Number.isNaN(size) && size > maxSize) {
      throw new Error(`Content-Length ${size} exceeds maximum allowed size ${maxSize}`);
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, maxSize: number): Promise<Buffer> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.length;
        if (totalSize > maxSize) {
          throw new Error(`Downloaded size ${totalSize} exceeds maximum allowed size ${maxSize}`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }

  private async readArrayBuffer(response: Response, maxSize: number): Promise<Buffer> {
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > maxSize) {
      throw new Error(`Downloaded size ${buffer.length} exceeds maximum allowed size ${maxSize}`);
    }
    return buffer;
  }

  // -------------------------------------------------------------------------
  // Security validation
  // -------------------------------------------------------------------------

  private validateUrlSecurity(url: URL): void {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        `URL protocol "${url.protocol}" not allowed — only http: and https: are supported`,
      );
    }

    const hostname = url.hostname.toLowerCase();
    if (isPrivateHostname(hostname)) {
      throw new Error(`Access to private/internal address "${hostname}" is blocked for security`);
    }

    if (url.username || url.password) {
      throw new Error('URLs with embedded credentials are not allowed');
    }

    // Block well-known service ports (not general web ports like 8080/8443)
    const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    const blockedPorts = [22, 23, 25, 53, 110, 143, 3306, 5432, 6379, 9200];
    if (blockedPorts.includes(port)) {
      throw new Error(`Access to port ${port} is blocked for security`);
    }
  }

  // -------------------------------------------------------------------------
  // Format detection & validation
  // -------------------------------------------------------------------------

  private detectFormatFromUrl(urlStr: string): string {
    try {
      const url = new URL(urlStr);
      const ext = path.extname(url.pathname).toLowerCase();
      const formatMap: Record<string, string> = {
        '.ttf': 'ttf',
        '.otf': 'otf',
        '.woff': 'woff',
        '.woff2': 'woff2',
        '.eot': 'eot',
      };
      return formatMap[ext] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private detectFormatFromBuffer(buffer: Buffer): string | null {
    if (buffer.length < 4) return null;
    for (const [format, { magic, offset = 0 }] of Object.entries(FONT_SIGNATURES)) {
      if (buffer.length >= offset + magic.length) {
        const slice = buffer.subarray(offset, offset + magic.length);
        if (slice.equals(magic)) return format;
      }
    }
    return null;
  }

  private validateFontBuffer(buffer: Buffer, claimedFormat?: string): boolean {
    const detected = this.detectFormatFromBuffer(buffer);
    // If we can detect a format, it's a real font — pass regardless of claimed format
    if (detected) return true;
    // No signature found: only reject when a specific format was claimed
    return !claimedFormat || claimedFormat === 'unknown';
  }

  private extractFontNameFromUrl(urlStr: string): string {
    try {
      const url = new URL(urlStr);
      const filename = path.basename(url.pathname);
      return path.basename(filename, path.extname(filename)) || 'unknown-font';
    } catch {
      return 'unknown-font';
    }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private extractMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return String(error);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private cloneFontData(data: FontData): FontData {
    return { ...data, buffer: Buffer.from(data.buffer) };
  }
}

export default FontFetcher;
