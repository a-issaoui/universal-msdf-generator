import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { Msdfgen } from 'msdfgen-wasm';
import type { ConvertJobOptions, WorkerOutMessage } from './converter-worker.js';
import { appendUnicodeGlyphs, loadGlyphsByIds } from './glyph-loader.js';
import { buildLayout, packBins } from './layout-utils.js';
import { getRequiredGlyphIds, SCRIPT_DEFAULT_LANGUAGE } from './shaper.js';
import type { GenerateOptions, MSDFFailure, MSDFSuccess } from './types.js';
import { generateAtlasName, resolveCharset } from './utils.js';

/**
 * Atlas callback — invoked once per atlas page as it is rendered.
 */
export type AtlasCallback = (
  atlas: { filename: string; texture: Buffer },
  index: number,
  total: number,
) => Promise<void>;

/**
 * Core MSDF generation engine backed by msdfgen-wasm.
 */
export class MSDFConverter {
  private options: GenerateOptions;
  private gen: Msdfgen | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: GenerateOptions = {}) {
    this.options = {
      useWorkers: true,
      concurrency: 4,
      ...options,
    };
  }

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('msdfgen-wasm/wasm');
      const ab = (await fs.readFile(wasmPath)).buffer;
      this.gen = await Msdfgen.create(ab);
    })();
    return this.initPromise;
  }

  async dispose(): Promise<void> {
    if (this.gen) {
      this.gen.dispose();
      this.gen = null;
    }
  }

  async convert(
    fontBuffer: Buffer,
    fontName: string,
    jobOptions: ConvertJobOptions = {},
    options: GenerateOptions = {},
  ): Promise<MSDFSuccess | MSDFFailure> {
    const timeoutMs = options.generationTimeout ?? 30000;
    const atlasCallback = options.onAtlas;

    const useWorkers = options.useWorkers ?? this.options.useWorkers ?? !process.env.VITEST;
    if (!useWorkers) {
      return this._executeInlineConversion(
        fontBuffer,
        fontName,
        jobOptions,
        atlasCallback,
        options,
      );
    }
    return this._runViaWorker(fontBuffer, fontName, jobOptions, timeoutMs, atlasCallback, options);
  }

  private async _loadGlyphsWithShaping(
    gen: Msdfgen,
    charString: string,
    fontBuffer: Buffer,
    jobOptions: ConvertJobOptions,
  ): Promise<{
    glyphIdMap: Record<number, number>;
    glyphIdToAdvance: Map<number, number>;
    shapingEngine: 'harfbuzz';
    shapedText: string;
    upem: number;
  }> {
    const analysis = analyzeCharset(charString);
    const resolvedScript = jobOptions.script ?? analysis.primaryScript ?? 'Arab';
    const shapingOpts = {
      direction: jobOptions.direction ?? (analysis.hasRtl ? 'rtl' : analysis.primaryDirection),
      script: resolvedScript,
      language: jobOptions.language ?? SCRIPT_DEFAULT_LANGUAGE[resolvedScript] ?? 'en',
    };

    const shaperResult = await getRequiredGlyphIds(charString, fontBuffer, shapingOpts);
    const loaderResult = loadGlyphsByIds(
      gen,
      shaperResult.glyphIds,
      shaperResult.glyphIdToCodepoint,
      {
        preprocess: jobOptions.fixOverlaps ?? true,
        advances: shaperResult.glyphIdToAdvance,
      },
    );

    return {
      glyphIdMap: Object.fromEntries(loaderResult.glyphIdToUnicode),
      glyphIdToAdvance: shaperResult.glyphIdToAdvance,
      shapingEngine: 'harfbuzz',
      upem: shaperResult.upem,
      shapedText: shaperResult.shapedGlyphIds
        .map((gid) => {
          const unicode = loaderResult.glyphIdToUnicode.get(gid);
          return unicode ? String.fromCodePoint(unicode) : '';
        })
        .join(''),
    };
  }

  private async _renderAtlases(
    gen: Msdfgen,
    fontName: string,
    bins: PackedGlyphsBin[],
    atlasCallback: AtlasCallback | undefined,
  ): Promise<Array<{ filename: string; texture: Buffer }>> {
    const atlases: Array<{ filename: string; texture: Buffer }> = [];
    for (let i = 0; i < bins.length; i++) {
      const filename = generateAtlasName(fontName, i, bins.length);
      const texture = Buffer.from(gen.createAtlasImage(bins[i]));
      const atlas = { filename, texture };
      if (atlasCallback) {
        await atlasCallback(atlas, i, bins.length);
      } else {
        atlases.push(atlas);
      }
    }
    return atlases;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: intentional — inline shaping+packing pipeline
  private async _executeInlineConversion(
    fontBuffer: Buffer,
    fontName: string,
    jobOptions: ConvertJobOptions,
    atlasCallback: AtlasCallback | undefined,
    options: GenerateOptions,
  ): Promise<MSDFSuccess | MSDFFailure> {
    try {
      await this.initialize();
      const gen = this.gen as Msdfgen;
      gen.loadFont(fontBuffer);

      const charString = resolveCharset(jobOptions.charset);

      let glyphIdMap: Record<number, number> | undefined;
      let glyphIdToAdvance: Map<number, number> | undefined;
      let shapingEngine: 'harfbuzz' | 'none' = 'none';
      let shapedText: string | undefined;
      let shapingUpem = 1000;

      if (jobOptions.complexShaping) {
        const shapingInput = jobOptions.shapingText ?? charString;
        const shaped = await this._loadGlyphsWithShaping(gen, shapingInput, fontBuffer, jobOptions);
        glyphIdMap = shaped.glyphIdMap;
        glyphIdToAdvance = shaped.glyphIdToAdvance;
        shapingEngine = shaped.shapingEngine;
        shapedText = shaped.shapedText;
        shapingUpem = shaped.upem;

        if (jobOptions.shapingText && jobOptions.shapingText !== charString) {
          const shapingCps = new Set(Array.from(shapingInput, (c) => c.codePointAt(0)));
          const remainingCps = Array.from(new Set(charString), (c) => c.codePointAt(0)).filter(
            (cp): cp is number => cp !== undefined && !shapingCps.has(cp),
          );
          if (remainingCps.length > 0) {
            appendUnicodeGlyphs(gen, remainingCps, { preprocess: jobOptions.fixOverlaps ?? true });
          }
        }
      } else {
        const codepoints = Array.from(new Set(charString), (c) => c.codePointAt(0)).filter(
          (cp): cp is number => cp !== undefined,
        );
        if (codepoints.length > 0) {
          gen.loadGlyphs(codepoints, { preprocess: jobOptions.fixOverlaps ?? true });
        }
      }

      const bins = packBins(gen, jobOptions);
      const atlases = await this._renderAtlases(gen, fontName, bins, atlasCallback);
      const layout = buildLayout(
        fontName,
        bins,
        gen.metrics,
        atlases.map((a) => a.filename),
        (jobOptions.fontSize as number) || 48,
        (jobOptions.fieldRange as number) || 4,
      );

      // Final Precision Layout correction
      if (glyphIdToAdvance && glyphIdMap) {
        for (const char of layout.chars) {
          const glyphId = Object.entries(glyphIdMap).find(([_gid, u]) => u === char.id)?.[0];
          if (glyphId !== undefined) {
            const adv = glyphIdToAdvance.get(Number.parseInt(glyphId, 10));
            if (adv !== undefined) {
              const scale = ((jobOptions.fontSize as number) || 48) / shapingUpem;
              char.xadvance = adv * scale;
            }
          }
        }
      }

      const charsetStr = resolveCharset(jobOptions.charset);
      if (options.onProgress) options.onProgress(100, 1, 1);

      return {
        success: true,
        fontName,
        data: layout,
        atlases,
        metadata: {
          charset: charsetStr.length,
          fontSize: (jobOptions.fontSize as number) || 48,
          textureSize: (jobOptions.textureSize as [number, number]) || [2048, 2048],
          atlasCount: atlases.length,
          fieldRange: (jobOptions.fieldRange as number) || 4,
          generatedAt: new Date().toISOString(),
          engine: 'msdfgen-wasm',
          shapingEngine,
          glyphIdMap,
          shapedText,
        },
      } satisfies MSDFSuccess;
    } catch (e) {
      return {
        success: false,
        fontName,
        error: e instanceof Error ? e.message : String(e),
      } satisfies MSDFFailure;
    }
  }

  private async _runViaWorker(
    fontBuffer: Buffer,
    fontName: string,
    jobOptions: ConvertJobOptions,
    timeoutMs: number,
    atlasCallback: AtlasCallback | undefined,
    _options: GenerateOptions,
  ): Promise<MSDFSuccess | MSDFFailure> {
    const require = createRequire(import.meta.url);
    const workerPath = require.resolve('./converter-worker.js');
    const worker = new Worker(workerPath);

    return new Promise((resolve) => {
      const atlases: Array<{ filename: string; texture: Buffer }> = [];
      const timeout = setTimeout(() => {
        worker.terminate();
        resolve({ success: false, fontName, error: `Timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: intentional — worker message dispatch
      worker.on('message', (msg: WorkerOutMessage) => {
        if (msg.type === 'ready') {
          worker.postMessage({ type: 'convert', fontBuffer, fontName, options: jobOptions });
        } else if (msg.type === 'atlas') {
          const texture = Buffer.from(msg.texture);
          const atlas = { filename: msg.filename, texture };
          if (atlasCallback) atlasCallback(atlas, msg.index, msg.total);
          else atlases.push(atlas);
        } else if (msg.type === 'result') {
          clearTimeout(timeout);
          worker.terminate();
          const charsetStr = resolveCharset(jobOptions.charset);
          resolve({
            success: true,
            fontName,
            data: msg.layout,
            atlases,
            metadata: {
              charset: charsetStr.length,
              fontSize: (jobOptions.fontSize as number) || 48,
              textureSize: (jobOptions.textureSize as [number, number]) || [2048, 2048],
              atlasCount: msg.layout.pages?.length ?? atlases.length,
              fieldRange: (jobOptions.fieldRange as number) || 4,
              generatedAt: new Date().toISOString(),
              engine: 'msdfgen-wasm',
              shapingEngine: msg.shapingEngine || 'none',
              glyphIdMap: msg.glyphIdMap,
              shapedText: msg.shapedText,
            },
          });
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          worker.terminate();
          resolve({ success: false, fontName, error: msg.message });
        }
      });

      worker.on('error', (err) => {
        clearTimeout(timeout);
        worker.terminate();
        resolve({ success: false, fontName, error: err.message });
      });
    });
  }
}

/** Utility to help with script detection logic inside the converter */
function analyzeCharset(text: string) {
  const isRtl = /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF]/.test(text);
  return {
    hasRtl: isRtl,
    primaryScript: isRtl ? 'Arab' : 'Latn',
    primaryDirection: isRtl ? 'rtl' : 'ltr',
  };
}

let sharedConverter: MSDFConverter | null = null;

export function getSharedConverter(options?: GenerateOptions): MSDFConverter {
  if (!sharedConverter) {
    sharedConverter = new MSDFConverter(options);
  }
  return sharedConverter;
}

export function disposeSharedConverter(): void {
  if (sharedConverter) {
    sharedConverter.dispose();
    sharedConverter = null;
  }
}

export default MSDFConverter;
