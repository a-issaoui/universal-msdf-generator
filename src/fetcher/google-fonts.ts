/**
 * fetcher/google-fonts.ts
 * Google Fonts handler: resolves font names to binaries via the Google Fonts CSS2 API.
 */

import { detectFormatFromExtension } from '../font-format.js';
import { loadFont } from '../font-loader.js';
import type { FontData, GoogleFontOptions } from '../types.js';
import type { NetworkClient } from './network.js';
import { googleFontsRateLimiter, protectBuffer } from './network.js';

interface ParsedFontBlock {
  url: string;
  format: string;
  unicodeRange: string | null;
}

/** Google Fonts weight alias → numeric weight */
const WEIGHT_MAP: Record<string, string> = {
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

export class GoogleFontsHandler {
  constructor(
    private readonly client: NetworkClient,
    private readonly verbose: boolean,
  ) {}

  async fetchGoogleFont(fontName: string, options: GoogleFontOptions = {}): Promise<FontData> {
    const { weight = '400', style = 'normal', signal } = options;

    const normalizedWeight = weight.toLowerCase().replace(/[- ]/g, '');
    const resolvedWeight = WEIGHT_MAP[normalizedWeight] || weight;

    if (signal?.aborted) throw new Error('Fetch aborted');

    await googleFontsRateLimiter.acquire();
    const ital = style === 'italic' ? '1' : '0';
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      fontName,
    )}:ital,wght@${ital},${resolvedWeight}&display=swap`;

    // UA → expected format pairs. Default: WOFF first (smaller), TTF second, any last.
    // When preferTTF is set, TTF is tried first so the saved binary can be used for
    // future local MSDF regeneration without re-downloading.
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
        return await this._attemptFetch(
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
        errors.push({ format: attempt.format, error: this._extractMessage(err) });
      }
    }

    const detail = errors.map((e) => `${e.format}: ${e.error}`).join('; ');
    throw new Error(
      `Failed to fetch Google Font "${fontName}" (weight: ${weight}, style: ${style}): ${detail}`,
    );
  }

  private async _attemptFetch(
    cssUrl: string,
    fontName: string,
    weight: string,
    style: string,
    userAgent: string,
    preferredFormat: 'woff' | 'ttf' | 'any',
    signal?: AbortSignal,
  ): Promise<FontData> {
    const cssResponse = await this.client.fetchWithRetry(cssUrl, { userAgent, signal });
    const css = await cssResponse.text();

    const fontUrl = this.extractLatinFontUrl(css, preferredFormat);
    if (!fontUrl) throw new Error(`No ${preferredFormat} font URL found in CSS response`);

    const fontResponse = await this.client.fetchWithRetry(fontUrl, { userAgent, signal });
    const buffer = await this.client.readResponseWithSizeLimit(fontResponse);

    const loaded = await loadFont(buffer, {
      verbose: this.verbose,
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

  // --------------------------------------------------------------------------
  // CSS parsing
  // --------------------------------------------------------------------------

  extractLatinFontUrl(css: string, preferredFormat: 'woff' | 'ttf' | 'any'): string | null {
    const blocks = this._parseFontFaceBlocks(css);
    if (blocks.length === 0) return null;

    const candidates =
      preferredFormat === 'any'
        ? blocks
        : blocks.filter((b) => b.format === preferredFormat || b.format === 'unknown');

    if (candidates.length === 0) return null;

    const latinBlock = this._findLatinBlock(candidates);
    return latinBlock?.url ?? candidates[candidates.length - 1].url;
  }

  private _parseFontFaceBlocks(css: string): ParsedFontBlock[] {
    const blocks: ParsedFontBlock[] = [];
    const rawBlocks = css.split(/@font-face\s*\{/i).slice(1);

    for (const rawBlock of rawBlocks) {
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
      const format = this._canonicalizeFormat(formatHint) ?? detectFormatFromExtension(url);

      const rangeMatch = blockContent.match(/unicode-range\s*:\s*([^;]+)/i);
      const unicodeRange = rangeMatch?.[1].trim() ?? null;

      blocks.push({ url, format, unicodeRange });
    }

    return blocks;
  }

  private _canonicalizeFormat(format: string): string | null {
    const map: Record<string, string> = {
      truetype: 'ttf',
      opentype: 'otf',
      woff: 'woff',
      woff2: 'woff2',
      'embedded-opentype': 'eot',
    };
    return map[format] ?? null;
  }

  private _findLatinBlock(blocks: ParsedFontBlock[]): ParsedFontBlock | null {
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

  private _extractMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return String(error);
  }
}
