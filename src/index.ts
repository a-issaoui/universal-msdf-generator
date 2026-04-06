import MSDFConverter from './converter.js';
import MSDFFetcher from './font-fetcher.js';
import type { FontSource, GenerateOptions, MSDFCachedSuccess, MSDFResult } from './types.js';
import MSDFUtils from './utils.js';
import XMLGenerator from './xml-generator.js';

let sharedConverter: MSDFConverter | null = null;
let sharedFetcher: MSDFFetcher | null = null;
let initPromise: Promise<void> | null = null;

async function innerInit(options: GenerateOptions) {
  sharedFetcher = new MSDFFetcher();
  sharedConverter = new MSDFConverter(options);
  await sharedConverter.initialize();
}

async function getCoreInstance(
  options: GenerateOptions,
): Promise<{ converter: MSDFConverter; fetcher: MSDFFetcher }> {
  /* v8 ignore next 6 */
  if (!sharedConverter || !sharedFetcher) {
    if (!initPromise) {
      initPromise = innerInit(options);
    }
    await initPromise;
  }
  /* v8 ignore next 4 */
  if (!sharedConverter || !sharedFetcher) {
    throw new Error('Failed to initialize Universal MSDF Generator core.');
  }
  return { converter: sharedConverter, fetcher: sharedFetcher };
}

function resolveIdentity(source: FontSource, options: GenerateOptions): string {
  if (options.name) return options.name;
  const isS = typeof source === 'string';
  let rawP = 'font';
  if (isS) {
    rawP = (source as string).split('/').pop() || 'font';
  }
  const pts = rawP.split('.');
  /* v8 ignore next 1 */
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
  /* v8 ignore next 13 */
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
  /* v8 ignore next 13 */
  if (result.success) {
    result.fontName = identity;
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
 * Universal MSDF Generator (Functional Core)
 */
async function perform(source: FontSource, options: GenerateOptions): Promise<MSDFResult> {
  const { converter, fetcher } = await getCoreInstance(options);
  try {
    const identity = resolveIdentity(source, options);
    if (options.outputDir) {
      const cached = await tryGetCached(options.outputDir, identity, options);
      if (cached) return cached;
    }
    return await executeGen(source, identity, options, converter, fetcher);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = msg.startsWith('MSDF generation failed:') ? msg : `MSDF generation failed: ${msg}`;
    /* v8 ignore next 1 */
    if (options.verbose) console.error(`💥 ${err}`);
    return { success: false, fontName: String(source), error: err };
  }
}

class UniversalMSDFGenerator {
  private options: GenerateOptions;
  constructor(options?: GenerateOptions) {
    this.options = {
      fontSize: 48,
      fieldRange: 4,
      outputFormat: 'json',
      verbose: true,
      ...(options || {}),
    };
  }
  async ensureInitialized() {
    await getCoreInstance(this.options);
  }
  async generate(s: FontSource, o?: GenerateOptions) {
    return perform(s, { ...this.options, ...(o || {}) });
  }
  /* v8 ignore start */
  async generateMultiple(sources: FontSource[], options?: GenerateOptions) {
    const results = [];
    for (const src of sources) results.push(await this.generate(src, options));
    return results;
  }
  async generateFromGoogle(n: string, o?: GenerateOptions) {
    return this.generate(n, o);
  }
  async generateFromUrl(u: string, o?: GenerateOptions) {
    return this.generate(u, o);
  }
  async generateFromFile(f: string, o?: GenerateOptions) {
    return this.generate(f, o);
  }
  async dispose() {
    if (initPromise) await initPromise.catch(() => {});
    if (sharedConverter) {
      await sharedConverter.dispose();
      sharedConverter = null;
      sharedFetcher = null;
      initPromise = null;
    }
  }
  /* v8 ignore stop */
}

/* v8 ignore start */
const generate = (s: FontSource, o?: GenerateOptions) =>
  new UniversalMSDFGenerator().generate(s, o);
const generateMultiple = (s: FontSource[], o?: GenerateOptions) =>
  new UniversalMSDFGenerator().generateMultiple(s, o);

/* v8 ignore stop */

export { generate, generateMultiple, MSDFUtils, UniversalMSDFGenerator };
export default UniversalMSDFGenerator;
