/**
 * fetcher/url-handler.ts
 * HTTP/HTTPS URL font handler with security validation.
 */

import path from 'node:path';
import { URL } from 'node:url';
import { loadFont } from '../font-loader.js';
import type { FontData } from '../types.js';
import type { NetworkClient } from './network.js';
import { protectBuffer } from './network.js';
import { validateUrlSecurity } from './security.js';

export function extractFontNameFromUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    const filename = path.basename(url.pathname);
    return path.basename(filename, path.extname(filename)) || 'unknown-font';
  } catch {
    return 'unknown-font';
  }
}

export class UrlHandler {
  constructor(
    private readonly client: NetworkClient,
    private readonly verbose: boolean,
  ) {}

  async fetchFromUrl(url: string | URL, options: { signal?: AbortSignal } = {}): Promise<FontData> {
    const urlObj = url instanceof URL ? url : new URL(url as string);
    validateUrlSecurity(urlObj);

    const response = await this.client.fetchWithRetry(urlObj.href, { signal: options.signal });
    const buffer = await this.client.readResponseWithSizeLimit(response);

    const loaded = await loadFont(buffer, {
      verbose: this.verbose,
      sourceHint: urlObj.href,
    });

    return {
      buffer: protectBuffer(loaded.buffer),
      name: extractFontNameFromUrl(urlObj.href),
      format: loaded.format,
      source: 'url',
      originalUrl: urlObj.href,
      originalFormat: loaded.originalFormat,
      wasConverted: loaded.wasConverted,
      metadata: loaded.stats,
    };
  }
}
