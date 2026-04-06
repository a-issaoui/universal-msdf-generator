import type MSDFConverter from './converter.js';
import type FontFetcher from './font-fetcher.js';
import type {
  FontSource,
  GenerateOptions,
  MSDFCachedSuccess,
  MSDFFailure,
  MSDFResult,
  OutputFormat,
} from './types.js';
import MSDFUtils, { resolveCharset } from './utils.js';

export * from './types.js';

// ---------------------------------------------------------------------------
// Public functional API
// ---------------------------------------------------------------------------

/**
 * Generates a single MSDF font atlas.
 *
 * This is the recommended entry point for one-shot generation. It creates a
 * short-lived generator, runs the job, then disposes the instance automatically.
 */
export async function generate(
  source: FontSource,
  options: GenerateOptions = {},
): Promise<MSDFResult> {
  const generator = new UniversalMSDFGenerator();
  try {
    return await generator.generate(source, options);
  } finally {
    await generator.dispose();
  }
}

/**
 * Generates multiple MSDF font atlases in sequence.
 *
 * Prefers sequential processing over parallel to avoid saturating the native
 * msdf-bmfont-xml worker when batching large character sets.
 */
export async function generateMultiple(
  sources: FontSource[],
  options: GenerateOptions = {},
): Promise<MSDFResult[]> {
  const generator = new UniversalMSDFGenerator();
  try {
    return await generator.generateMultiple(sources, options);
  } finally {
    await generator.dispose();
  }
}

// ---------------------------------------------------------------------------
// Core generator class
// ---------------------------------------------------------------------------

/**
 * Universal MSDF Generator (UMG).
 *
 * Lazily loads Node.js-only dependencies so the package stays importable in
 * browser environments (where the browser-safe subset of exports can still be
 * used for type checking and consuming pre-generated assets).
 */
class UniversalMSDFGenerator {
  private converter!: MSDFConverter;
  private fetcher!: FontFetcher;
  private defaultOptions: GenerateOptions;

  /**
   * Stores the in-flight initialization promise so that concurrent calls to
   * `generate()` share one initialization rather than racing to set `this.converter`.
   */
  private initPromise: Promise<void> | null = null;

  constructor(options: GenerateOptions = {}) {
    this.defaultOptions = options;
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Lazily initializes Node.js-only dependencies.
   *
   * Storing the in-flight Promise (rather than a boolean flag) makes this
   * safe against concurrent invocations: the second caller awaits the same
   * Promise instead of starting a second initialization race.
   */
  private ensureInitialized(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    if (typeof window !== 'undefined') {
      return Promise.reject(
        new Error(
          '[UMG] The Core generator cannot run directly in the browser. ' +
            'Import your pre-generated MSDF JSON assets directly in browser environments.',
        ),
      );
    }

    this.initPromise = (async () => {
      try {
        const [converterMod, fetcherMod] = await Promise.all([
          import('./converter.js'),
          import('./font-fetcher.js'),
        ]);
        this.converter = new converterMod.default();
        this.fetcher = new fetcherMod.default();
      } catch (err) {
        // Reset so a subsequent call can retry
        this.initPromise = null;
        throw new Error(
          `[UMG] Failed to initialize Node-only components: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();

    return this.initPromise;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Main entry point for generating MSDF from various sources (Node.js).
   */
  async generate(source: FontSource, options: GenerateOptions = {}): Promise<MSDFResult> {
    await this.ensureInitialized();
    const mergedOptions = this.mergeOptions(options);

    // Resolve charset preset names ("ascii", "latin", etc.) to actual character strings
    // so that "-c ascii" expands to all 95 printable ASCII characters, not the literal
    // four-character string "ascii".
    mergedOptions.charset = resolveCharset(
      Array.isArray(mergedOptions.charset) ? mergedOptions.charset.join('') : mergedOptions.charset,
    );

    const identity = this.getIdentity(source, mergedOptions);

    // Cache check: skip generation when force is NOT set and output already exists.
    const cached = await this.checkCache(identity, mergedOptions);
    if (cached) return cached;

    try {
      const fontData = await this.fetcher.fetch(source);
      const result = await this.converter.convert(fontData.buffer, fontData.name, mergedOptions);

      if (result.success && !result.cached) {
        // Enforce deterministic identity across the entire result surface
        result.fontName = identity;

        // Generate .fnt XML when the chosen format requires it
        const format: OutputFormat = mergedOptions.outputFormat ?? 'json';
        if (format === 'fnt' || format === 'both' || format === 'all') {
          const xmlMod = await import('./xml-generator.js');
          result.xml = xmlMod.default.generate(result.data, identity);
        }

        await this.handleOutput(result, identity, mergedOptions);
      }

      return result;
    } catch (error) {
      return this.buildFailure(error, String(source), mergedOptions.verbose);
    }
  }

  /**
   * Batch-process multiple fonts sequentially.
   */
  async generateMultiple(
    sources: FontSource[],
    options: GenerateOptions = {},
  ): Promise<MSDFResult[]> {
    await this.ensureInitialized();
    const merged = this.mergeOptions(options);
    const verbose = merged.verbose ?? true;

    if (verbose) {
      console.log(`\n📦 Batch processing ${sources.length} fonts...`);
    }

    const results: MSDFResult[] = [];

    for (let i = 0; i < sources.length; i++) {
      const fontLabel = typeof sources[i] === 'string' ? sources[i] : 'buffer';
      if (verbose) {
        console.log(`\nProcessing font ${i + 1}/${sources.length}: ${fontLabel}`);
      }

      try {
        results.push(await this.generate(sources[i], options));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (verbose) {
          console.error(`Failed to process font ${i + 1}: ${message}`);
        }
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Merges caller options with instance-level defaults.
   * All caller-supplied keys — including `force` — are preserved verbatim.
   */
  private mergeOptions(options: GenerateOptions): GenerateOptions {
    const merged: GenerateOptions = {
      ...this.defaultOptions, // Apply instance defaults
      ...options, // Apply per-call overrides
    };

    // Ensure verbose has a sane default if not specified anywhere
    if (!('verbose' in merged)) {
      merged.verbose = true;
    }

    return merged;
  }

  /**
   * Derives a deterministic, filesystem-safe filename identity for a task.
   *
   * Rules applied:
   *  1. If `options.name` is set, it is used as-is (caller's responsibility).
   *  2. The font name is slugified: lowercased, spaces → hyphens, non-alphanumeric stripped.
   *  3. Weight, style, font size, and field range are appended so that different
   *     generation parameters produce different cache keys, preventing collisions
   *     between e.g. Roboto-400-normal-48 and Roboto-700-italic-48.
   */
  private getIdentity(source: FontSource, options: GenerateOptions): string {
    if (options.name) return options.name;

    const rawName =
      typeof source === 'string' ? (source.split('/').pop()?.split('.')[0] ?? 'font') : 'font';

    const slug = rawName
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');

    const weight = options.weight ?? '400';
    const style = options.style ?? 'normal';
    const fontSize = options.fontSize ?? 48;
    const fieldRange = options.fieldRange ?? 4;

    return `${slug}-${weight}-${style}-${fontSize}-r${fieldRange}`;
  }

  /**
   * Checks whether valid output files already exist for the given identity.
   *
   * Returns a typed `MSDFCachedSuccess` (not a fake `MSDFSuccess` with an empty
   * `data` object) so callers can discriminate on `result.cached` and know they
   * should load assets from `result.savedFiles` rather than accessing `result.data`.
   *
   * Cache is skipped when `options.force` is true, regardless of `reuseExisting`.
   */
  private async checkCache(
    identity: string,
    options: GenerateOptions,
  ): Promise<MSDFCachedSuccess | null> {
    if (!options.reuseExisting || options.force || !options.outputDir) {
      return null;
    }

    const exists = await MSDFUtils.checkMSDFOutputExists(options.outputDir, identity, {
      format: options.outputFormat,
    });

    if (!exists) return null;

    if (options.verbose) {
      console.log(`✨ Re-using existing MSDF for: ${identity}`);
    }

    return {
      success: true,
      cached: true,
      fontName: identity,
      metadata: {
        charset: 0,
        fontSize: options.fontSize ?? 48,
        textureSize: (options.textureSize ?? [1024, 1024]) as [number, number],
        fieldRange: options.fieldRange ?? 4,
        generatedAt: new Date().toISOString(),
        engine: 'cached',
      },
      savedFiles: MSDFUtils.getExpectedFiles(
        options.outputDir,
        identity,
        options.outputFormat ?? 'json',
      ),
    };
  }

  /** Saves outputs to disk when `outputDir` is configured. */
  private async handleOutput(
    result: MSDFResult,
    name: string,
    options: GenerateOptions,
  ): Promise<void> {
    if (!options.outputDir || !result.success || result.cached) return;

    if (options.verbose) {
      console.log(`Saving outputs to: ${options.outputDir}`);
    }

    (result as import('./types.js').MSDFSuccess).savedFiles = await MSDFUtils.saveMSDFOutput(
      result,
      options.outputDir,
      {
        filename: name,
        format: options.outputFormat,
      },
    );
  }

  /** Builds a standardized failure result and optionally logs the error. */
  private buildFailure(error: unknown, fontName: string, verbose?: boolean): MSDFFailure {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = 'MSDF generation failed:';
    const finalMessage = message.startsWith(prefix) ? message : `${prefix} ${message}`;

    if (verbose) {
      console.error(`💥 ${finalMessage}`);
    }

    return { success: false, fontName, error: finalMessage };
  }

  // -------------------------------------------------------------------------
  // Convenience helpers
  // -------------------------------------------------------------------------

  /** Generate from a Google Font family name. */
  async generateFromGoogle(name: string, options: GenerateOptions = {}): Promise<MSDFResult> {
    return this.generate(name, options);
  }

  /** Generate from a remote font URL. */
  async generateFromUrl(url: string, options: GenerateOptions = {}): Promise<MSDFResult> {
    return this.generate(url, options);
  }

  /** Generate from a local font file path. */
  async generateFromFile(filePath: string, options: GenerateOptions = {}): Promise<MSDFResult> {
    return this.generate(filePath, options);
  }

  async dispose(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise.catch(() => {});
      await this.converter?.dispose();
    }
  }
}

export { MSDFUtils, UniversalMSDFGenerator };
export default UniversalMSDFGenerator;
