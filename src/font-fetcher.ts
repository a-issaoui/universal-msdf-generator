/**
 * font-fetcher.ts
 * Production-hardened font retrieval engine with security, validation, and performance optimizations.
 */

import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { detectFormatFromExtension } from './font-format.js';
import { loadFont } from './font-loader.js';
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

// FONT_SIGNATURES removed in favor of font-format.ts

// ============================================================================
// Public types
// ============================================================================

export interface SecureFetchOptions extends FetchOptions {
  /** Base directory for local file resolution. When set, all local paths are relative to this. */
  basePath?: string;
  /**
   * Allow absolute paths when `basePath` is not set.
   * @default false
   * @security Only enable if you trust all callers to supply safe paths.
   */
  allowAbsolutePaths?: boolean;
  /**
   * Allow `..` traversal sequences when `basePath` is not set.
   * @default false
   * @security Only enable if you trust all callers to supply safe paths.
   */
  allowPathTraversal?: boolean;
  /** Maximum download size in bytes. Default: 20 MB. */
  maxDownloadSize?: number;
  /** Retry attempts for transient network failures. Default: 3. */
  maxRetries?: number;
  /** Shared cache map for request deduplication across instances. */
  cache?: Map<string, Promise<FontData>>;
  /**
   * Custom DNS resolver for DNS-rebinding / SSRF protection.
   * Called before every URL fetch. Returning a private IP causes the request to be blocked.
   * Defaults to `node:dns/promises lookup`.
   */
  dnsResolver?: (hostname: string) => Promise<string>;
  /**
   * Enable SSRF protection (blocks private IPs, localhost, etc.).
   * @default true
   */
  enforceSafeUrls?: boolean;
  /** Enable detailed logging. Default: true. */
  verbose?: boolean;
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

async function defaultDnsResolver(hostname: string): Promise<string> {
  const result = await dnsLookup(hostname);
  return result.address;
}

// ============================================================================
// Rate Limiter (token bucket)
// ============================================================================

/**
 * Simple token-bucket rate limiter.
 * Used to throttle Google Fonts CSS endpoint requests.
 */
export class RateLimiter {
  public tokens: number;
  public readonly max: number;
  private lastRefill = Date.now();

  constructor(
    max: number,
    private readonly windowMs: number,
  ) {
    this.max = max;
    this.tokens = max;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / (this.max / this.windowMs));
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    return this.acquire();
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.max,
      this.tokens + ((now - this.lastRefill) * this.max) / this.windowMs,
    );
    this.lastRefill = now;
  }
}

/** Module-level rate limiter for Google Fonts CSS endpoint (10 req/s). @internal */
export const googleFontsRateLimiter = new RateLimiter(10, 1000);

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
  return hash.digest('hex').slice(0, 32);
}

/**
 * Best-effort buffer protection in development. Prevents common accidental mutations
 * (via .write(), .fill(), or .set()) but cannot intercept direct index assignment
 * (buffer[i] = x). For guaranteed isolation, use Buffer.from(result.buffer) to
 * create a private copy.
 */
function protectBuffer(buffer: Buffer): Buffer {
  // In non-production environments, we protect the buffer by overriding its
  // mutating methods to prevent accidental corruption of the cache.
  // Note: Object.freeze(buffer) throws for Buffers/TypedArrays with elements.
  if (process.env.NODE_ENV !== 'production') {
    const throwErr = () => {
      throw new Error('Cannot mutate cached font buffer. Use Buffer.from() to copy first.');
    };
    Object.defineProperties(buffer, {
      write: { value: throwErr, enumerable: false, configurable: true },
      fill: { value: throwErr, enumerable: false, configurable: true },
      set: { value: throwErr, enumerable: false, configurable: true },
    });
  }
  return buffer;
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
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      userAgent:
        options.userAgent ?? 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko',
      maxDownloadSize: options.maxDownloadSize ?? MAX_DOWNLOAD_SIZE,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      basePath: options.basePath,
      allowAbsolutePaths: options.allowAbsolutePaths,
      allowPathTraversal: options.allowPathTraversal,
      signal: options.signal,
      cache: options.cache,
      enforceSafeUrls: options.enforceSafeUrls ?? true,
      dnsResolver: options.dnsResolver,
      verbose: options.verbose ?? true,
    };

    if (this.options.basePath) {
      if (!path.isAbsolute(this.options.basePath)) {
        throw new Error(`basePath must be an absolute path: "${this.options.basePath}"`);
      }
      this.options.basePath = path.normalize(this.options.basePath);
    }

    this.requestCache = options.cache ?? new Map();
    this.activeRequests = new Map();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Primary entry point for fetching font data.
   * Detects source type automatically and caches results for deduplication.
   *
   * Note: callers MUST NOT mutate the returned `buffer` — it may be shared across
   * cache hits. Use `Buffer.from(result.buffer)` to get a private copy when needed.
   */
  async fetch(source: FontSource, googleOptions?: GoogleFontOptions): Promise<FontData> {
    const cacheKey = generateCacheKey(source, googleOptions);

    const cached = this.requestCache.get(cacheKey);
    if (cached) return cached;

    const controller = new AbortController();
    this.activeRequests.set(cacheKey, controller);

    const promise = this.executeFetch(source, googleOptions, controller.signal).finally(() => {
      this.activeRequests.delete(cacheKey);
    });

    this.requestCache.set(cacheKey, promise);
    return promise;
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
    signal?: AbortSignal,
  ): Promise<FontData> {
    const sourceType = await this.detectSourceType(source);
    switch (sourceType) {
      case 'google':
        return this.fetchGoogleFont(source as string, { ...googleOptions, signal });
      case 'url':
        return this.fetchFromUrl(source instanceof URL ? source : new URL(source as string), {
          signal,
        });
      case 'local':
        return this.fetchLocalFile(String(source), { signal });
      case 'buffer':
        return this.processBufferSource(source);
      /* v8 ignore start */
      default:
        throw new Error(`Unsupported font source type: ${sourceType}`);
      /* v8 ignore stop */
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
    /* v8 ignore start */
    if (typeof source !== 'string') {
      return 'unknown';
    }
    /* v8 ignore stop */
    return this.detectStringSource(source);
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

  private async processBufferSource(source: FontSource): Promise<FontData> {
    let buffer: Buffer;
    if (Buffer.isBuffer(source)) {
      buffer = source;
    } else if (ArrayBuffer.isView(source)) {
      buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    } else {
      buffer = Buffer.from(source as ArrayBuffer);
    }

    const loaded = await loadFont(buffer, {
      verbose: this.options.verbose,
      sourceHint: 'buffer source',
    });

    return {
      buffer: protectBuffer(loaded.buffer),
      name: 'buffer-font',
      format: loaded.format,
      source: 'buffer',
      originalFormat: loaded.originalFormat,
      wasConverted: loaded.wasConverted,
      metadata: loaded.stats,
    };
  }

  // -------------------------------------------------------------------------
  // Google Fonts
  // -------------------------------------------------------------------------

  async fetchGoogleFont(fontName: string, options: GoogleFontOptions = {}): Promise<FontData> {
    const { weight = '400', style = 'normal', signal } = options;

    // Map common aliases to numeric weights for Google Fonts v2 API
    const WeightMap: Record<string, string> = {
      thin: '100',
      extralight: '200',
      light: '300',
      regular: '400',
      normal: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
      extrabold: '800',
      black: '900',
    };

    const normalizedWeight = weight.toLowerCase().replace(/[- ]/g, '');
    const resolvedWeight = WeightMap[normalizedWeight] || weight;

    // Check for early abort
    if (signal?.aborted) throw new Error('Fetch aborted');

    // Rate-limit calls to the Google Fonts CSS endpoint
    await googleFontsRateLimiter.acquire();
    const ital = style === 'italic' ? '1' : '0';
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      fontName,
    )}:ital,wght@${ital},${resolvedWeight}&display=swap`;

    // UA → expected format pairs. Default order: WOFF first (smaller), TTF second, any last.
    // When preferTTF is set (i.e. saveFontFile: true), TTF is tried first so the
    // saved binary can be used for future local MSDF regeneration without re-downloading.
    const baseAttempts: Array<{ ua: string; format: 'woff' | 'ttf' | 'any' }> = [
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
    const attempts = options.preferTTF
      ? [baseAttempts[1], baseAttempts[0], baseAttempts[2]]
      : baseAttempts;

    const errors: Array<{ format: string; error: string }> = [];

    for (const attempt of attempts) {
      if (signal?.aborted) throw new Error('Fetch aborted');
      try {
        return await this.attemptGoogleFontFetch(
          cssUrl,
          fontName,
          weight,
          style,
          attempt.ua,
          attempt.format,
          signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
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
    signal?: AbortSignal,
  ): Promise<FontData> {
    const cssResponse = await this.fetchWithRetry(cssUrl, { userAgent, signal });
    const css = await cssResponse.text();

    const fontUrl = this.extractLatinFontUrl(css, preferredFormat);
    if (!fontUrl) throw new Error(`No ${preferredFormat} font URL found in CSS response`);

    // Validate the extracted URL before fetching
    const fontUrlObj = new URL(fontUrl);
    this.validateUrlSecurity(fontUrlObj);

    const fontResponse = await this.fetchWithRetry(fontUrl, { userAgent, signal });
    const buffer = await this.readResponseWithSizeLimit(fontResponse);

    const loaded = await loadFont(buffer, {
      verbose: this.options.verbose,
      sourceHint: `Google Font "${fontName}"`,
    });

    return {
      buffer: protectBuffer(loaded.buffer),
      name: fontName,
      weight,
      style,
      format: loaded.format,
      source: 'google',
      originalFormat: loaded.originalFormat,
      wasConverted: loaded.wasConverted,
      metadata: loaded.stats,
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
      const format = this.canonicalizeFormat(formatHint) ?? detectFormatFromExtension(url);

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
    options: { format?: string; name?: string; signal?: AbortSignal } = {},
  ): Promise<FontData> {
    const urlObj = url instanceof URL ? url : new URL(url);
    await this.validateUrlSecurity(urlObj);

    const response = await this.fetchWithRetry(urlObj.href, { signal: options.signal });
    const buffer = await this.readResponseWithSizeLimit(response);

    const loaded = await loadFont(buffer, {
      verbose: this.options.verbose,
      sourceHint: urlObj.href,
    });

    return {
      buffer: protectBuffer(loaded.buffer),
      name: this.extractFontNameFromUrl(urlObj.href),
      format: loaded.format,
      source: 'url',
      originalUrl: urlObj.href,
      originalFormat: loaded.originalFormat,
      wasConverted: loaded.wasConverted,
      metadata: loaded.stats,
    };
  }

  // -------------------------------------------------------------------------
  // Local file fetching
  // -------------------------------------------------------------------------

  async fetchLocalFile(
    filePath: string,
    options: { name?: string; format?: string; signal?: AbortSignal } = {},
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
      /* v8 ignore start */
      if (err instanceof Error && err.name === 'AbortError') throw err;
      /* v8 ignore stop */
      throw new Error(`Failed to read local file "${filePath}": ${this.extractMessage(err)}`);
    }

    const loaded = await loadFont(buffer, {
      verbose: this.options.verbose,
      sourceHint: resolvedPath,
    });

    // Check for mid-loop abort before returning
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Fetch aborted');

    return {
      buffer: protectBuffer(loaded.buffer),
      name: options.name ?? path.basename(resolvedPath, path.extname(resolvedPath)),
      format: loaded.format,
      path: resolvedPath,
      source: 'local',
      originalFormat: loaded.originalFormat,
      wasConverted: loaded.wasConverted,
      metadata: loaded.stats,
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

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.makeRequest(url, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (lastError.name === 'AbortError' || !this.isRetryableError(lastError)) {
          throw lastError;
        }

        if (attempt < maxRetries) {
          await this.sleep(RETRY_DELAY_BASE * 2 ** attempt);
        }
      }
    }

    /* v8 ignore start */
    throw new Error(
      `Failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`,
    );
    /* v8 ignore stop */
  }

  /** Determines if an error is deterministic/fatal and should NOT be retried. */
  private isRetryableError(error: Error): boolean {
    const msg = error.message;
    return !(
      (
        msg.includes('blocked') ||
        msg.includes('traversal') ||
        msg.includes('too large') ||
        msg.includes('not allowed') ||
        msg.includes('DNS resolution failed') ||
        msg.includes('HTTP 4')
      ) // 4xx client errors
    );
  }

  private async makeRequest(
    url: string,
    options: { userAgent?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    // DNS-level SSRF check: resolve the hostname and verify it is not a private address
    await this.validateUrlSecurityAsync(new URL(url));

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const err = new Error(`Request timed out (${this.options.timeout}ms): ${url}`);
      err.name = 'AbortError';
      controller.abort(err);
    }, this.options.timeout as number);

    // If an external signal is provided (per-request or global FetchOptions), link to controller
    const externalSignal = options.signal ?? this.options.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeout);
        // v8 ignore next: externalSignal.reason is always set when aborted via our AbortController
        throw externalSignal.reason ?? new Error('Request aborted by external signal');
      }
      externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), {
        once: true,
      });
    }

    let response: Response;
    try {
      if (this.options.verbose) {
        console.log(`[FontFetcher] Fetching: ${url}`);
        console.log(`[FontFetcher] UA: ${options.userAgent ?? (this.options.userAgent as string)}`);
      }

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
      // Ensure we preserve the AbortError name for detection in fetchWithRetry
      if (err instanceof Error && err.name === 'AbortError') throw err;
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

  /**
   * Async URL security check that resolves the hostname via DNS and blocks
   * requests whose resolved IP falls in a private/loopback range.
   * Called in makeRequest() before every network fetch.
   */
  private async validateUrlSecurityAsync(url: URL): Promise<void> {
    const resolver = this.options.dnsResolver ?? defaultDnsResolver;
    let resolvedIp: string;
    try {
      resolvedIp = await resolver(url.hostname);
    } catch {
      throw new Error(`DNS resolution failed for "${url.hostname}"`);
    }
    if (isPrivateHostname(resolvedIp)) {
      throw new Error(
        `Resolved IP "${resolvedIp}" for "${url.hostname}" is blocked (private/internal address)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Format detection & validation
  // -------------------------------------------------------------------------

  // detectFormatFromUrl, detectFormatFromBuffer, and validateFontBuffer removed in favor of font-loader.ts

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
}

export default FontFetcher;
