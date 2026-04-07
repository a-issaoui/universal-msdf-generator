import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { FontMetrics, PackedGlyphsBin } from 'msdfgen-wasm';
import { Msdfgen } from 'msdfgen-wasm';
import type { GenerateOptions, MSDFFailure, MSDFLayout, MSDFSuccess } from './types.js';
import { resolveCharset } from './utils.js';

/**
 * Generates an atlas filename based on texture count.
 */
function generateAtlasName(fontName: string, index: number, count: number): string {
  return count > 1 ? `${fontName}-${index}.png` : `${fontName}.png`;
}

/**
 * Runs a promise with a hard timeout. Rejects with a timeout error if ms elapses.
 *
 * ⚠️ IMPORTANT LIMITATION: This timeout only abandons the waiting promise.
 * The underlying WASM computation continues executing synchronously on the main thread
 * and CANNOT be aborted in Node.js. CPU and memory remain occupied until completion.
 */
function withTimeout<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
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
      /* v8 ignore next 4 — fn() always resolves (try-catch inside); reject path unreachable */
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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
  // round: convert normalized em units → pixels (2 decimal precision)
  const round = (x: number) => Math.round(x * 100 * fontSize) / 100;

  const chars: MSDFLayout['chars'] = [];
  const kernings: MSDFLayout['kernings'] = [];

  for (let pageIdx = 0; pageIdx < bins.length; pageIdx++) {
    const bin = bins[pageIdx];
    for (const rect of bin.rects) {
      const glyph = rect.glyph;
      const range = rect.msdfData.range; // already in em units (range_px / fontSize)
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

  // Atlas dimensions from first bin; all bins share the same maxWidth/maxHeight constraint
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
 */
class MSDFConverter {
  private options: GenerateOptions;
  private gen: Msdfgen | null = null;
  private initPromise: Promise<void> | null = null;

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
    const buf = readFileSync(wasmPath);
    // Ensure we have a standalone ArrayBuffer (Buffer may share its underlying buffer)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    this.gen = await Msdfgen.create(ab);
  }

  async convert(
    fontBuffer: Buffer,
    fontName: string,
    options: GenerateOptions = {},
  ): Promise<MSDFSuccess | MSDFFailure> {
    // Use ?? so explicit falsy values (e.g. fontSize: 0, charset: '') are respected
    const charset = options.charset ?? this.options.charset;
    const fontSize = options.fontSize ?? this.options.fontSize;
    const textureSize = options.textureSize ?? this.options.textureSize;
    const fieldRange = options.fieldRange ?? this.options.fieldRange;
    const edgeColoring = options.edgeColoring ?? this.options.edgeColoring ?? 'simple';
    const padding = options.padding ?? this.options.padding ?? 2;
    const fixOverlaps = options.fixOverlaps ?? this.options.fixOverlaps ?? true;
    const timeoutMs = options.generationTimeout ?? this.options.generationTimeout ?? 60_000;

    const hasProgress = !!options.onProgress;
    if (hasProgress) {
      options.onProgress?.(0, 0, 1);
    }

    return withTimeout(timeoutMs, fontName, async () => {
      try {
        await this.initialize();
        const gen = this.gen as Msdfgen;

        // Load font binary into WASM (supports TTF, OTF, WOFF — not WOFF2)
        gen.loadFont(
          new Uint8Array(fontBuffer.buffer, fontBuffer.byteOffset, fontBuffer.byteLength),
        );

        // Resolve charset to an array of unique codepoints
        const charString = resolveCharset(charset);
        const codepoints = [
          ...new Set(
            [...charString]
              .map((c) => c.codePointAt(0))
              .filter((cp): cp is number => cp !== undefined),
          ),
        ];

        if (codepoints.length > 0) {
          gen.loadGlyphs(codepoints, { preprocess: fixOverlaps });
        }

        // Atlas dimensions
        const [maxW, maxH] = (textureSize as [number, number] | null | undefined) ?? [2048, 2048];

        const bins =
          codepoints.length > 0
            ? gen.packGlyphs(
                { size: fontSize as number, range: fieldRange as number, edgeColoring },
                {
                  maxWidth: maxW,
                  maxHeight: maxH,
                  padding,
                  pot: true,
                  smart: true,
                  allowRotation: false,
                },
              )
            : [];

        // Render PNG atlases
        const atlases = bins.map((bin, i) => ({
          filename: generateAtlasName(fontName, i, bins.length),
          texture: Buffer.from(gen.createAtlasImage(bin)),
        }));

        const metrics = gen.metrics;
        const layout = buildLayout(
          fontName,
          bins,
          metrics,
          atlases,
          fontSize as number,
          fieldRange as number,
        );

        const charsetStr = resolveCharset(charset);

        if (hasProgress) {
          options.onProgress?.(100, 1, 1);
        }

        return {
          success: true,
          fontName,
          data: layout,
          atlases,
          metadata: {
            charset: charsetStr.length,
            fontSize: fontSize as number,
            textureSize: textureSize as [number, number],
            atlasCount: atlases.length,
            fieldRange: fieldRange as number,
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
    });
  }

  async convertMultiple(
    fonts: Array<{ buffer: Buffer; name: string }>,
    options: GenerateOptions = {},
  ): Promise<Array<MSDFSuccess | MSDFFailure>> {
    const results: Array<MSDFSuccess | MSDFFailure> = [];
    const total = fonts.length;
    for (let i = 0; i < total; i++) {
      try {
        const font = fonts[i];
        const result = await this.convert(font.buffer, font.name, {
          ...options,
          onProgress: (p) => {
            const overall = ((i + p / 100) / total) * 100;
            options.onProgress?.(overall, i + 1, total);
          },
        });
        results.push(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ success: false, fontName: fonts[i].name, error: msg });
      }
    }
    return results;
  }

  async dispose(): Promise<void> {
    if (this.gen) {
      // Set to null to release the reference and allow GC.
      // msdfgen-wasm manages WASM memory internally — no .delete() needed.
      this.gen = null;
    }
    this.initPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Module-level shared WASM instance
// Used by standalone convenience functions (generate / generateMultiple) so that
// the WASM module is initialized once and reused across calls.
// UniversalMSDFGenerator manages its own instance and is NOT affected by this.
// NOTE: This is intentionally never disposed — it lives for the process lifetime.
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

/**
 * Disposes the shared WASM converter instance.
 * Useful for long-running server processes to manage memory.
 */
export async function disposeSharedConverter(): Promise<void> {
  if (_sharedConverter) {
    await _sharedConverter.dispose();
    _sharedConverter = null;
  }
  _sharedConverterInit = null;
}

export default MSDFConverter;
