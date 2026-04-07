import fs from 'node:fs/promises';
import path from 'node:path';
import MSDFConverter, { getSharedConverter } from './converter.js';
import type { SecureFetchOptions } from './font-fetcher.js';
import FontFetcher from './font-fetcher.js';
import type { FontSource, GenerateOptions, MSDFCachedSuccess, MSDFResult } from './types.js';
import MSDFUtils from './utils.js';
import XMLGenerator from './xml-generator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts security/fetch fields from GenerateOptions and maps them to
 * SecureFetchOptions so that FontFetcher receives the caller-supplied constraints.
 */
function buildFetcherOptions(opts?: GenerateOptions): SecureFetchOptions {
  return {
    basePath: opts?.basePath,
    allowAbsolutePaths: opts?.allowAbsolutePaths,
    allowPathTraversal: opts?.allowPathTraversal,
    maxDownloadSize: opts?.maxDownloadSize,
    maxRetries: opts?.maxRetries,
    timeout: opts?.generationTimeout,
    verbose: opts?.verbose,
  };
}

function resolveIdentity(source: FontSource, options: GenerateOptions): string {
  if (options.name) return options.name;
  const isS = typeof source === 'string';
  let rawP = 'font';
  if (isS) {
    rawP = (source as string).split('/').pop() || 'font';
  }
  const pts = rawP.split('.');
  const n = pts[0] || 'font';
  const slug = n
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  const w = options.weight || '400';
  const s = options.style || 'normal';
  return `${slug}-${w}-${s}-${options.fontSize}-r${options.fieldRange}`;
}

async function tryGetCached(
  oDir: string,
  identity: string,
  options: GenerateOptions,
): Promise<MSDFCachedSuccess | null> {
  const reuse = !!options.reuseExisting;
  const force = !!options.force;
  if (!(reuse && !force)) return null;

  const meta = await MSDFUtils.loadMetadata(oDir, identity);
  if (!meta) return null;

  const atlasCount = meta.atlasCount || 1;
  const expected = MSDFUtils.getExpectedFiles(
    oDir,
    identity,
    options.outputFormat || 'json',
    atlasCount,
  );

  const exists = await MSDFUtils.checkMSDFOutputExists(oDir, identity, {
    format: options.outputFormat,
  });

  if (!exists) return null;

  if (options.verbose) console.log(`✨ Re-using MSDF: ${identity} (${atlasCount} atlases)`);

  return {
    success: true,
    cached: true,
    fontName: identity,
    metadata: { ...meta, engine: 'cached' },
    savedFiles: expected,
  } as unknown as MSDFCachedSuccess;
}

async function saveFontToDisk(
  font: { buffer: Buffer; source: string; format?: string },
  outputDir: string,
  identity: string,
  verbose: boolean,
): Promise<string | undefined> {
  if (font.source !== 'google' && font.source !== 'url') return undefined;
  const ext = font.format ?? 'ttf';
  const fontFilePath = path.join(path.resolve(outputDir), `${identity}.${ext}`);
  await fs.writeFile(fontFilePath, font.buffer);
  if (verbose) console.log(`Font saved: ${fontFilePath}`);
  return fontFilePath;
}

async function executeGen(
  source: FontSource,
  identity: string,
  options: GenerateOptions,
  converter: MSDFConverter,
  fetcher: FontFetcher,
): Promise<MSDFResult> {
  const font = await fetcher.fetch(source, {
    weight: options.weight,
    style: options.style,
    preferTTF: options.saveFontFile,
  });
  const result = await converter.convert(font.buffer, font.name, options);
  if (result.success) {
    result.fontName = identity;
    result.fontMetadata = {
      originalFormat: font.originalFormat,
      wasConverted: font.wasConverted,
      compressionRatio: font.metadata?.compressionRatio,
      decompressionTimeMs: font.metadata?.decompressionTimeMs,
    };

    // Renormalize atlas filenames and layout pages to use identity as the base.
    // The converter names atlases after font.name (e.g. "Roboto"); we need them
    // to match the JSON/FNT filename (identity) so all files share a consistent stem.
    result.atlases = result.atlases.map((atlas, i) => ({
      ...atlas,
      filename: result.atlases.length > 1 ? `${identity}-${i}.png` : `${identity}.png`,
    }));
    result.data = {
      ...result.data,
      pages: result.atlases.map((a) => a.filename),
    };

    const fmt = options.outputFormat;
    let needsXml = false;
    if (fmt === 'fnt' || fmt === 'both' || fmt === 'all') needsXml = true;
    if (needsXml) result.xml = XMLGenerator.generate(result.data, identity);
    if (options.outputDir) {
      if (options.verbose) console.log(`Saving to: ${options.outputDir}`);
      result.savedFiles = await MSDFUtils.saveMSDFOutput(result, options.outputDir, {
        filename: identity,
        format: options.outputFormat,
      });

      // Save the raw font binary alongside the atlas when requested.
      if (options.saveFontFile) {
        result.savedFontFile = await saveFontToDisk(
          font,
          options.outputDir,
          identity,
          options.verbose ?? false,
        );
      }
    }
  }
  return result;
}

/**
 * Universal MSDF Generator
 */
class UniversalMSDFGenerator {
  private options: GenerateOptions;
  private converter: MSDFConverter | null = null;
  private fetcher: FontFetcher | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options?: GenerateOptions) {
    this.options = {
      fontSize: 48,
      fieldRange: 4,
      outputFormat: 'json',
      verbose: true,
      ...(options || {}),
    };
  }

  private _useShared = false;
  /** @internal */
  _enableSharedConverter() {
    this._useShared = true;
  }

  private async ensureCore(): Promise<{ converter: MSDFConverter; fetcher: FontFetcher }> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.fetcher = new FontFetcher(buildFetcherOptions(this.options));
        if (this._useShared) {
          this.converter = await getSharedConverter();
        } else {
          this.converter = new MSDFConverter(this.options);
          await this.converter.initialize();
        }
      })();
    }
    await this.initPromise;
    // TypeScript cannot see that initPromise sets these fields, so assert via cast
    const converter = this.converter as MSDFConverter;
    const fetcher = this.fetcher as FontFetcher;
    return { converter, fetcher };
  }

  async ensureInitialized() {
    await this.ensureCore();
  }

  private async _perform(source: FontSource, options: GenerateOptions): Promise<MSDFResult> {
    try {
      const { converter, fetcher } = await this.ensureCore();
      const identity = resolveIdentity(source, options);
      if (options.outputDir) {
        const cached = await tryGetCached(options.outputDir, identity, options);
        if (cached) return cached;
      }
      return await executeGen(source, identity, options, converter, fetcher);
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e);
      const msg = rawMsg.startsWith('MSDF generation failed:')
        ? rawMsg
        : `MSDF generation failed: ${rawMsg}`;
      if (options.verbose) console.error(`💥 ${msg}`);
      return { success: false, fontName: String(source), error: msg };
    }
  }

  async generate(s: FontSource, o?: GenerateOptions) {
    return this._perform(s, { ...this.options, ...(o || {}) });
  }

  async generateMultiple(sources: FontSource[], options?: GenerateOptions): Promise<MSDFResult[]> {
    const total = sources.length;
    const limit = options?.concurrency ?? Number.POSITIVE_INFINITY;
    const mergedOptions = { ...this.options, ...(options || {}) };

    let completedCount = 0;

    const runOne = async (index: number): Promise<void> => {
      const perFontOptions: GenerateOptions = {
        ...mergedOptions,
        onProgress: mergedOptions.onProgress
          ? (p: number) => {
              const overall = ((completedCount + p / 100) / total) * 100;
              mergedOptions.onProgress?.(overall, completedCount, total);
            }
          : undefined,
      };
      try {
        results[index] = await this.generate(sources[index], perFontOptions);
      } finally {
        completedCount++;
        mergedOptions.onProgress?.((completedCount / total) * 100, completedCount, total);
      }
    };

    const results: MSDFResult[] = new Array(total);

    if (!Number.isFinite(limit) || limit >= total) {
      await Promise.all(sources.map((_, i) => runOne(i)));
      return results;
    }

    const limitFn = (() => {
      const queue: Array<() => void> = [];
      let active = 0;
      const next = () => {
        active--;
        if (queue.length > 0) queue.shift()?.();
      };
      return async <T>(fn: () => Promise<T>): Promise<T> => {
        if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
        active++;
        try {
          return await fn();
        } finally {
          next();
        }
      };
    })();

    await Promise.all(sources.map((_, i) => limitFn(() => runOne(i))));
    return results;
  }

  /** @deprecated Since v1.5.0. Use {@link generate} directly — source type is auto-detected. Will be removed in v2.0. */
  async generateFromGoogle(n: string, o?: GenerateOptions) {
    console.warn('[DEPRECATED] generateFromGoogle() is deprecated. Use generate() instead.');
    return this.generate(n, o);
  }

  /** @deprecated Since v1.5.0. Use {@link generate} directly — source type is auto-detected. Will be removed in v2.0. */
  async generateFromUrl(u: string, o?: GenerateOptions) {
    console.warn('[DEPRECATED] generateFromUrl() is deprecated. Use generate() instead.');
    return this.generate(u, o);
  }

  /** @deprecated Since v1.5.0. Use {@link generate} directly — source type is auto-detected. Will be removed in v2.0. */
  async generateFromFile(f: string, o?: GenerateOptions) {
    console.warn('[DEPRECATED] generateFromFile() is deprecated. Use generate() instead.');
    return this.generate(f, o);
  }

  async dispose() {
    if (this.initPromise) await this.initPromise.catch(() => {});
    // Only dispose if we own the converter (it's not the shared one)
    if (this.converter && !this._useShared) {
      await this.converter.dispose();
    }
    this.converter = null;
    this.fetcher = null;
    this.initPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Standalone convenience functions — reuse the module-level shared WASM instance
// so that repeated calls do not pay the WASM initialization cost each time.
// NOTE: These do not import/font-fetcher.ts — circular dep invariant maintained.
// ---------------------------------------------------------------------------

const generate = async (s: FontSource, o?: GenerateOptions): Promise<MSDFResult> => {
  const gen = new UniversalMSDFGenerator(o);
  gen._enableSharedConverter();
  try {
    return await gen.generate(s, o);
  } finally {
    await gen.dispose();
  }
};

const generateMultiple = async (s: FontSource[], o?: GenerateOptions): Promise<MSDFResult[]> => {
  const gen = new UniversalMSDFGenerator(o);
  gen._enableSharedConverter();
  try {
    return await gen.generateMultiple(s, o);
  } finally {
    await gen.dispose();
  }
};

export type { SecureFetchOptions } from './font-fetcher.js';
export { generate, generateMultiple, MSDFUtils, UniversalMSDFGenerator };
export default UniversalMSDFGenerator;
