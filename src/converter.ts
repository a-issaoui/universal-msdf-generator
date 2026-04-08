import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { FontMetrics, PackedGlyphsBin } from 'msdfgen-wasm';
import { Msdfgen } from 'msdfgen-wasm';
import type {
  ConvertJobOptions,
  WorkerAtlasMessage,
  WorkerOutMessage,
} from './converter-worker.js';
import type { GenerateOptions, MSDFFailure, MSDFLayout, MSDFSuccess } from './types.js';
import { resolveCharset } from './utils.js';

/**
 * Atlas callback — invoked once per atlas page as it is rendered.
 * Allows immediate disk writes so only one atlas buffer is in memory at a time.
 */
export type AtlasCallback = (
  atlas: { filename: string; texture: Buffer },
  index: number,
  total: number,
) => Promise<void>;

/**
 * Generates an atlas filename based on texture count.
 */
function generateAtlasName(fontName: string, index: number, count: number): string {
  return count > 1 ? `${fontName}-${index}.png` : `${fontName}.png`;
}

/**
 * Builds an MSDFLayout from packed glyph bins and font metrics.
 */
function buildLayout(
  fontName: string,
  bins: PackedGlyphsBin[],
  metrics: FontMetrics,
  atlases: Array<{ filename: string; texture: Buffer }>,
  fontSize: number,
  fieldRange: number,
): MSDFLayout {
  const round = (x: number) => Math.round(x * 100 * fontSize) / 100;

  const chars: MSDFLayout['chars'] = [];
  const kernings: MSDFLayout['kernings'] = [];

  for (let pageIdx = 0; pageIdx < bins.length; pageIdx++) {
    const bin = bins[pageIdx];
    for (const rect of bin.rects) {
      const glyph = rect.glyph;
      const range = rect.msdfData.range;
      const hasSize = rect.width > 0 && rect.height > 0;

      chars.push({
        id: glyph.unicode,
        index: glyph.index,
        char: String.fromCodePoint(glyph.unicode),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        xoffset: hasSize ? round(glyph.left - range / 2) : 0,
        yoffset: hasSize ? round(metrics.ascenderY - (glyph.top + range / 2)) : 0,
        xadvance: round(glyph.advance),
        page: pageIdx,
        chnl: 15,
      });

      for (const [otherGlyph, amount] of glyph.kerning) {
        kernings.push({
          first: glyph.unicode,
          second: otherGlyph.unicode,
          amount: round(amount),
        });
      }
    }
  }

  const atlasW = bins.length > 0 ? bins[0].width : 0;
  const atlasH = bins.length > 0 ? bins[0].height : 0;

  return {
    pages: atlases.map((a) => a.filename),
    chars,
    info: {
      face: fontName,
      size: fontSize,
      bold: 0,
      italic: 0,
      charset: chars.map((c) => c.char),
      unicode: 1,
      stretchH: 100,
      smooth: 1,
      aa: 1,
      padding: [0, 0, 0, 0],
      spacing: [0, 0],
      outline: 0,
    },
    common: {
      lineHeight: round(metrics.lineHeight),
      base: round(metrics.ascenderY),
      scaleW: atlasW,
      scaleH: atlasH,
      pages: atlases.length,
      packed: 0,
      alphaChnl: 0,
      redChnl: 0,
      greenChnl: 0,
      blueChnl: 0,
    },
    distanceField: {
      fieldType: 'msdf',
      distanceRange: fieldRange,
      type: 'msdf',
      range: fieldRange,
    },
    kernings,
  };
}

/**
 * Core MSDF generation engine backed by msdfgen-wasm.
 *
 * In production (non-VITEST) environments, WASM runs in a dedicated worker thread.
 * When the `generationTimeout` fires, the worker is terminated — this actually kills
 * the WASM computation rather than just abandoning the Promise.
 *
 * In test environments (VITEST=1), the inline path is used so that vi.mock() mocks
 * of msdfgen-wasm continue to work without cross-thread complications.
 */
class MSDFConverter {
  private options: GenerateOptions;
  private gen: Msdfgen | null = null;
  private initPromise: Promise<void> | null = null;
  private worker: Worker | null = null;
  private workerReady: Promise<void> | null = null;

  constructor(options: GenerateOptions = {}) {
    this.options = {
      fontSize: 48,
      textureSize: [512, 512],
      fieldRange: 4,
      ...options,
    };
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this._doInitialize();
    }
    await this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('msdfgen-wasm/wasm');
    const buf = await fs.readFile(wasmPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    // Inline WASM instance — always used in test env (VITEST) so mocks work
    this.gen = await Msdfgen.create(ab);

    // Worker thread — used in production for real timeout termination
    if (!process.env.VITEST) {
      this.workerReady = this._spawnWorker();
    }
  }

  private _spawnWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./converter-worker.js', import.meta.url));
      worker.once('message', (msg: WorkerOutMessage) => {
        if (msg.type === 'ready') {
          this.worker = worker;
          resolve();
        } else {
          /* v8 ignore start */
          reject(new Error('Worker failed to initialise'));
        }
        /* v8 ignore stop */
      });
      /* v8 ignore next 3 */
      worker.once('error', reject);
    });
  }

  async convert(
    fontBuffer: Buffer,
    fontName: string,
    options: GenerateOptions = {},
    atlasCallback?: AtlasCallback,
  ): Promise<MSDFSuccess | MSDFFailure> {
    const charset = options.charset ?? this.options.charset;
    const fontSize = options.fontSize ?? this.options.fontSize;
    const textureSize = options.textureSize ?? this.options.textureSize;
    const fieldRange = options.fieldRange ?? this.options.fieldRange;
    const edgeColoring = options.edgeColoring ?? this.options.edgeColoring ?? 'simple';
    const padding = options.padding ?? this.options.padding ?? 2;
    const fixOverlaps = options.fixOverlaps ?? this.options.fixOverlaps ?? true;
    const timeoutMs = options.generationTimeout ?? this.options.generationTimeout ?? 60_000;

    const hasProgress = !!options.onProgress;
    if (hasProgress) options.onProgress?.(0, 0, 1);

    const jobOptions: ConvertJobOptions = {
      charset,
      fontSize: fontSize as number,
      textureSize: textureSize as [number, number] | null,
      fieldRange: fieldRange as number,
      edgeColoring,
      padding,
      fixOverlaps,
    };

    if (process.env.VITEST) {
      return this._runInline(fontBuffer, fontName, jobOptions, timeoutMs, atlasCallback, options);
    }
    return this._runViaWorker(fontBuffer, fontName, jobOptions, timeoutMs, atlasCallback, options);
  }

  // --------------------------------------------------------------------------
  // Inline path (used in tests so vi.mock('msdfgen-wasm') works)
  // --------------------------------------------------------------------------

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

      gen.loadFont(new Uint8Array(fontBuffer.buffer, fontBuffer.byteOffset, fontBuffer.byteLength));

      const charString = resolveCharset(
        jobOptions.charset as string | (string | number)[] | Set<string | number> | undefined,
      );
      const codepoints = Array.from(new Set(charString), (c) => c.codePointAt(0)).filter(
        (cp): cp is number => cp !== undefined,
      );

      if (codepoints.length > 0) {
        /* v8 ignore next */
        gen.loadGlyphs(codepoints, { preprocess: jobOptions.fixOverlaps ?? true });
      }

      const [maxW, maxH] = jobOptions.textureSize ?? [2048, 2048];
      const bins: PackedGlyphsBin[] =
        codepoints.length > 0
          ? gen.packGlyphs(
              {
                size: jobOptions.fontSize as number,
                range: jobOptions.fieldRange as number,
                /* v8 ignore next */
                edgeColoring: jobOptions.edgeColoring ?? 'simple',
              },
              {
                maxWidth: maxW,
                maxHeight: maxH,
                /* v8 ignore next */
                padding: jobOptions.padding ?? 2,
                pot: true,
                smart: true,
                allowRotation: false,
              },
            )
          : [];

      // ── Incremental atlas rendering (Fix 3+4) ──────────────────────────
      // Process one atlas at a time so peak memory stays at O(1 atlas).
      const atlases: Array<{ filename: string; texture: Buffer }> = [];
      for (let i = 0; i < bins.length; i++) {
        const filename = generateAtlasName(fontName, i, bins.length);
        const texture = Buffer.from(gen.createAtlasImage(bins[i]));
        const atlas = { filename, texture };
        if (atlasCallback) {
          await atlasCallback(atlas, i, bins.length);
          // Don't accumulate — write callback owns the buffer
        } else {
          atlases.push(atlas);
        }
      }

      const metrics = gen.metrics;
      const layout = buildLayout(
        fontName,
        bins,
        metrics,
        atlases,
        jobOptions.fontSize as number,
        jobOptions.fieldRange as number,
      );
      const charsetStr = resolveCharset(
        jobOptions.charset as string | (string | number)[] | Set<string | number> | undefined,
      );

      if (options.onProgress) options.onProgress(100, 1, 1);

      return {
        success: true,
        fontName,
        data: layout,
        atlases,
        metadata: {
          charset: charsetStr.length,
          fontSize: jobOptions.fontSize as number,
          textureSize: jobOptions.textureSize as [number, number],
          atlasCount: atlases.length,
          fieldRange: jobOptions.fieldRange as number,
          generatedAt: new Date().toISOString(),
          engine: 'msdfgen-wasm',
        },
      } satisfies MSDFSuccess;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        fontName,
        error: `msdfgen-wasm failed: ${msg}`,
      } satisfies MSDFFailure;
    }
  }

  private async _runInline(
    fontBuffer: Buffer,
    fontName: string,
    jobOptions: ConvertJobOptions,
    timeoutMs: number,
    atlasCallback: AtlasCallback | undefined,
    options: GenerateOptions,
  ): Promise<MSDFSuccess | MSDFFailure> {
    return this._withTimeout(timeoutMs, fontName, () =>
      this._executeInlineConversion(fontBuffer, fontName, jobOptions, atlasCallback, options),
    );
  }

  // --------------------------------------------------------------------------
  // Worker path (production — real termination on timeout)
  // --------------------------------------------------------------------------

  private async _handleAtlasMsg(
    msg: WorkerAtlasMessage,
    atlasCallback: AtlasCallback | undefined,
    atlases: Array<{ filename: string; texture: Buffer }>,
  ): Promise<void> {
    const texture = Buffer.from(msg.texture);
    const atlas = { filename: msg.filename, texture };
    if (atlasCallback) {
      await atlasCallback(atlas, msg.index, msg.total);
    } else {
      atlases.push(atlas);
    }
  }

  private _resolveWorkerResult(
    msg: { layout: MSDFLayout },
    atlases: Array<{ filename: string; texture: Buffer }>,
    jobOptions: ConvertJobOptions,
    fontName: string,
    options: GenerateOptions,
  ): MSDFSuccess {
    if (options.onProgress) options.onProgress(100, 1, 1);
    const pages = atlases.length > 0 ? atlases.map((a) => a.filename) : msg.layout.pages;
    const charsetStr = resolveCharset(
      jobOptions.charset as string | (string | number)[] | Set<string | number> | undefined,
    );
    return {
      success: true,
      fontName,
      data: { ...msg.layout, pages },
      atlases,
      metadata: {
        charset: charsetStr.length,
        fontSize: jobOptions.fontSize as number,
        textureSize: jobOptions.textureSize as [number, number],
        atlasCount: atlases.length,
        fieldRange: jobOptions.fieldRange as number,
        generatedAt: new Date().toISOString(),
        engine: 'msdfgen-wasm',
      },
    } satisfies MSDFSuccess;
  }

  private async _runViaWorker(
    fontBuffer: Buffer,
    fontName: string,
    jobOptions: ConvertJobOptions,
    timeoutMs: number,
    atlasCallback: AtlasCallback | undefined,
    options: GenerateOptions,
  ): Promise<MSDFSuccess | MSDFFailure> {
    await this.initialize();
    if (this.workerReady) await this.workerReady;

    // If the worker died (e.g. from a previous timeout), respawn it
    if (!this.worker) {
      this.workerReady = this._spawnWorker();
      await this.workerReady;
    }

    const worker = this.worker as Worker;
    const atlases: Array<{ filename: string; texture: Buffer }> = [];

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        worker.off('message', onMessage);
        // Terminate the worker — this actually kills the WASM computation
        await worker.terminate();
        this.worker = null;
        reject(new Error(`msdfgen-wasm timed out after ${timeoutMs}ms for "${fontName}"`));
      }, timeoutMs);

      const onMessage = async (msg: WorkerOutMessage) => {
        if (msg.type === 'atlas') {
          await this._handleAtlasMsg(msg as WorkerAtlasMessage, atlasCallback, atlases);
          return;
        }
        if (msg.type === 'result') {
          clearTimeout(timer);
          worker.off('message', onMessage);
          resolve(this._resolveWorkerResult(msg, atlases, jobOptions, fontName, options));
          return;
        }
        if (msg.type === 'error') {
          clearTimeout(timer);
          worker.off('message', onMessage);
          resolve({
            success: false,
            fontName,
            error: `msdfgen-wasm failed: ${msg.message}`,
          } satisfies MSDFFailure);
        }
      };

      worker.on('message', onMessage);

      // Transfer the font buffer to the worker (zero-copy)
      const fontUint8 = new Uint8Array(
        fontBuffer.buffer,
        fontBuffer.byteOffset,
        fontBuffer.byteLength,
      );
      const transferBuf = fontUint8.buffer.slice(
        fontUint8.byteOffset,
        fontUint8.byteOffset + fontUint8.byteLength,
      );
      const sendBuf = new Uint8Array(transferBuf);
      worker.postMessage({ type: 'convert', fontBuffer: sendBuf, fontName, options: jobOptions }, [
        transferBuf as ArrayBuffer,
      ]);
    });
  }

  // --------------------------------------------------------------------------
  // Timeout wrapper (only used by inline/test path)
  // --------------------------------------------------------------------------

  /**
   * Wraps a promise with a hard timeout (used only in the inline/test path).
   * In the worker path, `worker.terminate()` provides real termination.
   */
  private _withTimeout<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`msdfgen-wasm timed out after ${ms}ms for "${label}"`)),
        ms,
      );
      fn().then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        /* v8 ignore next 4 */
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async convertMultiple(
    fonts: Array<{ buffer: Buffer; name: string }>,
    options: GenerateOptions = {},
    atlasCallback?: AtlasCallback,
  ): Promise<Array<MSDFSuccess | MSDFFailure>> {
    const results: Array<MSDFSuccess | MSDFFailure> = [];
    const total = fonts.length;
    for (let i = 0; i < total; i++) {
      try {
        const font = fonts[i];
        const result = await this.convert(
          font.buffer,
          font.name,
          {
            ...options,
            onProgress: (p) => {
              const overall = ((i + p / 100) / total) * 100;
              options.onProgress?.(overall, i + 1, total);
            },
          },
          atlasCallback,
        );
        results.push(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ success: false, fontName: fonts[i].name, error: msg });
      }
    }
    return results;
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    if (this.gen) {
      this.gen = null;
    }
    this.initPromise = null;
    this.workerReady = null;
  }
}

// ---------------------------------------------------------------------------
// Module-level shared WASM instance
// ---------------------------------------------------------------------------

let _sharedConverter: MSDFConverter | null = null;
let _sharedConverterInit: Promise<MSDFConverter> | null = null;

export async function getSharedConverter(): Promise<MSDFConverter> {
  if (_sharedConverter) return _sharedConverter;
  if (!_sharedConverterInit) {
    _sharedConverterInit = (async () => {
      const c = new MSDFConverter({});
      await c.initialize();
      _sharedConverter = c;
      return c;
    })();
  }
  return _sharedConverterInit;
}

export async function disposeSharedConverter(): Promise<void> {
  if (_sharedConverter) {
    await _sharedConverter.dispose();
    _sharedConverter = null;
  }
  _sharedConverterInit = null;
}

export default MSDFConverter;
