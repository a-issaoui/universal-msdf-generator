/**
 * font-fetcher.ts
 * Orchestrator: detects font source type, routes to the appropriate handler,
 * and provides request deduplication and cancellation.
 *
 * Security, transport, and handler logic live in src/fetcher/*.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { GoogleFontsHandler } from './fetcher/google-fonts.js';
import { LocalFileHandler } from './fetcher/local-file.js';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT,
  generateCacheKey,
  googleFontsRateLimiter,
  MAX_DOWNLOAD_SIZE,
  NetworkClient,
  protectBuffer,
  RateLimiter,
} from './fetcher/network.js';
import { validateUrlSecurity } from './fetcher/security.js';
import { UrlHandler } from './fetcher/url-handler.js';
import { loadFont } from './font-loader.js';
import type { FetchOptions, FontData, FontSource, GoogleFontOptions } from './types.js';

// Re-export for consumers that import directly from font-fetcher
export { googleFontsRateLimiter, RateLimiter };

// ============================================================================
// Public types
// ============================================================================

export interface SecureFetchOptions extends FetchOptions {
  /** Base directory for local file resolution. All local paths are relative to this. */
  basePath?: string;
  /**
   * Allow absolute paths when `basePath` is not set.
   * @default false
   */
  allowAbsolutePaths?: boolean;
  /**
   * Allow `..` traversal sequences when `basePath` is not set.
   * @default false
   */
  allowPathTraversal?: boolean;
  /** Maximum download size in bytes. Default: 20 MB. */
  maxDownloadSize?: number;
  /** Retry attempts for transient network failures. Default: 3. */
  maxRetries?: number;
  /** Shared cache map for request deduplication across instances. */
  cache?: Map<string, Promise<FontData>>;
  /**
   * Custom DNS resolver for SSRF protection.
   * Returning a private IP causes the request to be blocked.
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

// ============================================================================
// FontFetcher
// ============================================================================

/**
 * Production-hardened font retrieval engine.
 *
 * Dispatches to handler sub-modules:
 * - GoogleFontsHandler  →  src/fetcher/google-fonts.ts
 * - UrlHandler          →  src/fetcher/url-handler.ts
 * - LocalFileHandler    →  src/fetcher/local-file.ts
 * - NetworkClient       →  src/fetcher/network.ts
 */
export class FontFetcher {
  private readonly opts: Required<
    Pick<
      SecureFetchOptions,
      'timeout' | 'userAgent' | 'maxDownloadSize' | 'maxRetries' | 'enforceSafeUrls' | 'verbose'
    >
  > &
    Pick<SecureFetchOptions, 'basePath' | 'signal' | 'dnsResolver'>;

  /** @internal — accessible via type casting in tests */
  readonly networkClient: NetworkClient;
  /** @internal — accessible via type casting in tests */
  readonly googleHandler: GoogleFontsHandler;
  /** @internal — accessible via type casting in tests */
  readonly urlHandler: UrlHandler;
  /** @internal — accessible via type casting in tests */
  readonly localHandler: LocalFileHandler;

  private readonly requestCache: Map<string, Promise<FontData>>;
  private readonly activeRequests: Map<string, AbortController>;

  constructor(options: SecureFetchOptions = {}) {
    this.opts = {
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      userAgent:
        options.userAgent ?? 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko',
      maxDownloadSize: options.maxDownloadSize ?? MAX_DOWNLOAD_SIZE,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      basePath: options.basePath,
      signal: options.signal,
      enforceSafeUrls: options.enforceSafeUrls ?? true,
      dnsResolver: options.dnsResolver,
      verbose: options.verbose ?? true,
    };

    if (this.opts.basePath) {
      if (!path.isAbsolute(this.opts.basePath)) {
        throw new Error(`basePath must be an absolute path: "${this.opts.basePath}"`);
      }
      this.opts.basePath = path.normalize(this.opts.basePath);
    }

    this.networkClient = new NetworkClient({
      timeout: this.opts.timeout,
      userAgent: this.opts.userAgent,
      maxRetries: this.opts.maxRetries,
      maxDownloadSize: this.opts.maxDownloadSize,
      signal: this.opts.signal,
      dnsResolver: this.opts.dnsResolver,
      verbose: this.opts.verbose,
    });

    this.googleHandler = new GoogleFontsHandler(this.networkClient, this.opts.verbose);
    this.urlHandler = new UrlHandler(this.networkClient, this.opts.verbose);
    this.localHandler = new LocalFileHandler({
      basePath: this.opts.basePath,
      maxDownloadSize: this.opts.maxDownloadSize,
      verbose: this.opts.verbose,
    });

    this.requestCache = options.cache ?? new Map();
    this.activeRequests = new Map();
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Primary entry point. Detects source type automatically and deduplicates concurrent requests.
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

    const promise = this._executeFetch(source, googleOptions, controller.signal).finally(() => {
      this.activeRequests.delete(cacheKey);
    });

    this.requestCache.set(cacheKey, promise);
    return promise;
  }

  /** Cancel an in-flight request. Returns true if cancelled. */
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

  async fetchGoogleFont(fontName: string, options: GoogleFontOptions = {}): Promise<FontData> {
    return this.googleHandler.fetchGoogleFont(fontName, options);
  }

  async fetchFromUrl(url: string | URL, options: { signal?: AbortSignal } = {}): Promise<FontData> {
    return this.urlHandler.fetchFromUrl(url, options);
  }

  async fetchLocalFile(
    filePath: string,
    options: { name?: string; signal?: AbortSignal } = {},
  ): Promise<FontData> {
    return this.localHandler.fetchLocalFile(filePath, options);
  }

  // --------------------------------------------------------------------------
  // Source detection & routing
  // --------------------------------------------------------------------------

  private async _executeFetch(
    source: FontSource,
    googleOptions?: GoogleFontOptions,
    signal?: AbortSignal,
  ): Promise<FontData> {
    const sourceType = await this._detectSourceType(source);
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
        return this._processBufferSource(source);
      /* v8 ignore start */
      default:
        throw new Error(`Unsupported font source type: ${sourceType}`);
      /* v8 ignore stop */
    }
  }

  _detectSourceType(
    source: FontSource,
  ): Promise<'google' | 'url' | 'local' | 'buffer' | 'unknown'> {
    if (Buffer.isBuffer(source) || ArrayBuffer.isView(source) || source instanceof ArrayBuffer) {
      return Promise.resolve('buffer');
    }
    if (source instanceof URL) {
      validateUrlSecurity(source);
      return Promise.resolve('url');
    }
    /* v8 ignore start */
    if (typeof source !== 'string') return Promise.resolve('unknown');
    /* v8 ignore stop */
    return this._detectStringSource(source.trim());
  }

  private async _detectStringSource(
    trimmed: string,
  ): Promise<'google' | 'url' | 'local' | 'unknown'> {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      validateUrlSecurity(url);
      return 'url';
    }

    const isExplicitPath =
      trimmed.startsWith('./') || trimmed.startsWith('../') || path.isAbsolute(trimmed);
    if (isExplicitPath) {
      return this._statForExplicitPath(trimmed);
    }

    if (this._isGoogleFontName(trimmed)) return 'google';

    try {
      const stats = await fs.stat(trimmed);
      if (stats.isFile()) return 'local';
    } catch {
      // not a file
    }
    return 'unknown';
  }

  private async _statForExplicitPath(trimmed: string): Promise<'local' | 'unknown'> {
    try {
      const stats = await fs.stat(trimmed);
      if (stats.isFile()) return 'local';
      if (stats.isDirectory()) throw new Error('Path is a directory, not a file.');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new Error('File not found.');
      throw err;
    }
    return 'unknown';
  }

  private _isGoogleFontName(s: string): boolean {
    return (
      /^[a-zA-Z][a-zA-Z0-9]*(?:[ -][a-zA-Z0-9]+)*$/.test(s) &&
      !s.includes('.') &&
      s.length >= 2 &&
      s.length <= 100
    );
  }

  private async _processBufferSource(source: FontSource): Promise<FontData> {
    let buffer: Buffer;
    if (Buffer.isBuffer(source)) {
      buffer = source;
    } else if (ArrayBuffer.isView(source)) {
      buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    } else {
      buffer = Buffer.from(source as ArrayBuffer);
    }

    const loaded = await loadFont(buffer, {
      verbose: this.opts.verbose,
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
}

export default FontFetcher;
