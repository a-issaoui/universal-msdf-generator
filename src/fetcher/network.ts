/**
 * fetcher/network.ts
 * HTTP transport layer: NetworkClient class, RateLimiter, cache-key generation,
 * buffer protection, and response-reading utilities.
 */

import { createHash } from 'node:crypto';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { URL } from 'node:url';
import type { FontSource, GoogleFontOptions } from '../types.js';
import { validateUrlSecurityAsync } from './security.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum allowed download size (20 MB — sufficient for the largest CJK fonts) */
export const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024;
/** Default request timeout in ms */
export const DEFAULT_TIMEOUT = 30_000;
/** Default retry attempts */
export const DEFAULT_MAX_RETRIES = 3;
/** Base delay for exponential backoff retry (ms) */
export const RETRY_DELAY_BASE = 1_000;

// ============================================================================
// Token-bucket rate limiter
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

// ============================================================================
// Cache-key generation
// ============================================================================

export function generateCacheKey(source: FontSource, options?: GoogleFontOptions): string {
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

// ============================================================================
// Buffer protection
// ============================================================================

/**
 * Best-effort buffer protection in development. Prevents common accidental mutations
 * (via .write(), .fill(), or .set()) but cannot intercept direct index assignment.
 * For guaranteed isolation, use Buffer.from(result.buffer) to create a private copy.
 */
export function protectBuffer(buffer: Buffer): Buffer {
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
// Utilities
// ============================================================================

export function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableError(error: Error): boolean {
  const msg = error.message;
  return !(
    msg.includes('blocked') ||
    msg.includes('traversal') ||
    msg.includes('too large') ||
    msg.includes('not allowed') ||
    msg.includes('DNS resolution failed') ||
    msg.includes('HTTP 4')
  );
}

// ============================================================================
// Response-reading helpers
// ============================================================================

export function checkContentLength(response: Response, maxSize: number): void {
  const header = response.headers?.get?.('content-length');
  if (!header) return;
  const size = Number.parseInt(header, 10);
  if (!Number.isNaN(size) && size > maxSize) {
    throw new Error(`Content-Length ${size} exceeds maximum allowed size ${maxSize}`);
  }
}

export async function readStream(
  body: ReadableStream<Uint8Array>,
  maxSize: number,
): Promise<Buffer> {
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

export async function readArrayBuffer(response: Response, maxSize: number): Promise<Buffer> {
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > maxSize) {
    throw new Error(`Downloaded size ${buffer.length} exceeds maximum allowed size ${maxSize}`);
  }
  return buffer;
}

export async function readResponseWithSizeLimit(
  response: Response,
  maxSize: number,
): Promise<Buffer> {
  checkContentLength(response, maxSize);
  return response.body ? readStream(response.body, maxSize) : readArrayBuffer(response, maxSize);
}

// ============================================================================
// NetworkClient — wraps fetch with timeout, retry, and DNS-pinned agent
// ============================================================================

export interface NetworkClientOptions {
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxDownloadSize?: number;
  signal?: AbortSignal;
  dnsResolver?: (hostname: string) => Promise<string>;
  verbose?: boolean;
}

export class NetworkClient {
  readonly timeout: number;
  readonly userAgent: string;
  readonly maxRetries: number;
  readonly maxDownloadSize: number;
  readonly signal?: AbortSignal;
  readonly dnsResolver?: (hostname: string) => Promise<string>;
  readonly verbose: boolean;

  constructor(options: NetworkClientOptions = {}) {
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.userAgent =
      /* v8 ignore next 2 */
      options.userAgent ?? 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko';
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxDownloadSize = options.maxDownloadSize ?? MAX_DOWNLOAD_SIZE;
    this.signal = options.signal;
    this.dnsResolver = options.dnsResolver;
    this.verbose = options.verbose ?? true;
  }

  sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  async fetchWithRetry(
    url: string,
    options: { userAgent?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.makeRequest(url, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError.name === 'AbortError' || !isRetryableError(lastError)) throw lastError;
        if (attempt < this.maxRetries) {
          const jitter = Math.random() * 1000;
          await this.sleep(RETRY_DELAY_BASE * 2 ** attempt + jitter);
        }
      }
    }
    /* v8 ignore start */
    throw new Error(
      `Failed after ${this.maxRetries} attempts: ${lastError?.message || 'Unknown error'}`,
    );
    /* v8 ignore stop */
  }

  async makeRequest(
    url: string,
    options: { userAgent?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const resolvedIp = await validateUrlSecurityAsync(new URL(url), this.dnsResolver);

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const err = new Error(`Request timed out (${this.timeout}ms): ${url}`);
      err.name = 'AbortError';
      controller.abort(err);
    }, this.timeout);

    const externalSignal = options.signal ?? this.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeout);
        // v8 ignore next
        throw externalSignal.reason ?? new Error('Request aborted by external signal');
      }
      externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), {
        once: true,
      });
    }

    let response: Response;
    try {
      if (this.verbose) {
        console.log(`[FontFetcher] Fetching: ${url}`);
        console.log(`[FontFetcher] UA: ${options.userAgent ?? this.userAgent}`);
      }

      const AgentClass = url.startsWith('https:') ? HttpsAgent : HttpAgent;
      const agent = new AgentClass({
        /* v8 ignore next */
        lookup: (_hostname, _opts, cb) => cb(null, resolvedIp, 4),
      });

      // biome-ignore lint/suspicious/noExplicitAny: Custom fetch proxy logic requires overriding native signatures
      response = await (fetch as any)(url, {
        signal: controller.signal,
        agent,
        headers: {
          'User-Agent': options.userAgent ?? this.userAgent,
          accept: 'font/woff2,font/woff,font/ttf,font/otf,*/*',
        },
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw err;
    }

    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response;
  }

  async readResponseWithSizeLimit(response: Response): Promise<Buffer> {
    return readResponseWithSizeLimit(response, this.maxDownloadSize);
  }
}
