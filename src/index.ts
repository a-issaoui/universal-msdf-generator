import MSDFConverter from './converter.js';
import MSDFFetcher from './font-fetcher.js';
import type { FontSource, GenerateOptions, MSDFCachedSuccess, MSDFResult } from './types.js';
import MSDFUtils from './utils.js';
import XMLGenerator from './xml-generator.js';

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

  const exists = await MSDFUtils.checkMSDFOutputExists(oDir, identity, {
    format: options.outputFormat,
  });
  if (exists) {
    if (options.verbose) console.log(`✨ Re-using MSDF: ${identity}`);
    return {
      success: true,
      cached: true,
      fontName: identity,
      metadata: {
        charset: 0,
        fontSize: options.fontSize as number,
        textureSize: options.textureSize as [number, number],
        fieldRange: options.fieldRange as number,
        generatedAt: new Date().toISOString(),
        engine: 'cached',
      },
      savedFiles: MSDFUtils.getExpectedFiles(oDir, identity, options.outputFormat || 'json'),
    } as MSDFCachedSuccess;
  }
  return null;
}

async function executeGen(
  source: FontSource,
  identity: string,
  options: GenerateOptions,
  converter: MSDFConverter,
  fetcher: MSDFFetcher,
): Promise<MSDFResult> {
  const font = await fetcher.fetch(source);
  const result = await converter.convert(font.buffer, font.name, options);
  if (result.success) {
    result.fontName = identity;

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
  private fetcher: MSDFFetcher | null = null;
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

  private async ensureCore(): Promise<{ converter: MSDFConverter; fetcher: MSDFFetcher }> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.fetcher = new MSDFFetcher();
        this.converter = new MSDFConverter(this.options);
        await this.converter.initialize();
      })();
    }
    await this.initPromise;
    // TypeScript cannot see that initPromise sets these fields, so assert via cast
    const converter = this.converter as MSDFConverter;
    const fetcher = this.fetcher as MSDFFetcher;
    return { converter, fetcher };
  }

  async ensureInitialized() {
    await this.ensureCore();
  }

  private async _perform(source: FontSource, options: GenerateOptions): Promise<MSDFResult> {
    const { converter, fetcher } = await this.ensureCore();
    try {
      const identity = resolveIdentity(source, options);
      if (options.outputDir) {
        const cached = await tryGetCached(options.outputDir, identity, options);
        if (cached) return cached;
      }
      return await executeGen(source, identity, options, converter, fetcher);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const err = msg.startsWith('MSDF generation failed:')
        ? msg
        : `MSDF generation failed: ${msg}`;
      if (options.verbose) console.error(`💥 ${err}`);
      return { success: false, fontName: String(source), error: err };
    }
  }

  async generate(s: FontSource, o?: GenerateOptions) {
    return this._perform(s, { ...this.options, ...(o || {}) });
  }

  async generateMultiple(sources: FontSource[], options?: GenerateOptions): Promise<MSDFResult[]> {
    const limit = options?.concurrency ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(limit) || limit >= sources.length) {
      return Promise.all(sources.map((src) => this.generate(src, options)));
    }
    // Concurrency-limited pool — preserves result order
    const results: MSDFResult[] = new Array(sources.length);
    let idx = 0;
    const workers = Array.from({ length: limit }, async () => {
      while (idx < sources.length) {
        const i = idx++;
        results[i] = await this.generate(sources[i], options);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /** @deprecated Use {@link generate} directly — source type is auto-detected. Will be removed in v2.0. */
  async generateFromGoogle(n: string, o?: GenerateOptions) {
    return this.generate(n, o);
  }

  /** @deprecated Use {@link generate} directly — source type is auto-detected. Will be removed in v2.0. */
  async generateFromUrl(u: string, o?: GenerateOptions) {
    return this.generate(u, o);
  }

  /** @deprecated Use {@link generate} directly — source type is auto-detected. Will be removed in v2.0. */
  async generateFromFile(f: string, o?: GenerateOptions) {
    return this.generate(f, o);
  }

  async dispose() {
    if (this.initPromise) await this.initPromise.catch(() => {});
    if (this.converter) {
      await this.converter.dispose();
    }
    this.converter = null;
    this.fetcher = null;
    this.initPromise = null;
  }
}

const generate = async (s: FontSource, o?: GenerateOptions): Promise<MSDFResult> => {
  const gen = new UniversalMSDFGenerator(o);
  try {
    return await gen.generate(s, o);
  } finally {
    await gen.dispose();
  }
};

const generateMultiple = async (s: FontSource[], o?: GenerateOptions): Promise<MSDFResult[]> => {
  const gen = new UniversalMSDFGenerator(o);
  try {
    return await gen.generateMultiple(s, o);
  } finally {
    await gen.dispose();
  }
};

export type { SecureFetchOptions } from './font-fetcher.js';
export { generate, generateMultiple, MSDFUtils, UniversalMSDFGenerator };
export default UniversalMSDFGenerator;
