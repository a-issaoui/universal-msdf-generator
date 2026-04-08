/**
 * converter-worker.ts
 * Worker thread for MSDF generation. Runs one persistent Msdfgen WASM instance
 * and processes conversion jobs via message passing.
 *
 * Running inside a worker thread allows `worker.terminate()` to actually kill
 * the WASM computation when a timeout fires — unlike the promise-only approach.
 *
 * Message protocol:
 *   MAIN → WORKER  { type: 'convert', fontBuffer: Uint8Array, fontName: string, options: ConvertJobOptions }
 *   WORKER → MAIN  { type: 'atlas',  filename: string, texture: Uint8Array, index: number, total: number }
 *   WORKER → MAIN  { type: 'result', layout: MSDFLayout }
 *   WORKER → MAIN  { type: 'error',  message: string }
 *   WORKER → MAIN  { type: 'ready' }  (after WASM initialisation)
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import type { FontMetrics, PackedGlyphsBin } from 'msdfgen-wasm';
import { Msdfgen } from 'msdfgen-wasm';
import type { MSDFLayout } from './types.js';
import { resolveCharset } from './utils.js';

// ============================================================================
// Types shared between main thread and worker
// ============================================================================

export interface ConvertJobOptions {
  charset?: unknown;
  fontSize?: number;
  textureSize?: [number, number] | null;
  fieldRange?: number;
  edgeColoring?: 'simple' | 'inktrap' | 'distance';
  padding?: number;
  fixOverlaps?: boolean;
}

export interface WorkerAtlasMessage {
  type: 'atlas';
  filename: string;
  texture: Uint8Array;
  index: number;
  total: number;
}

export interface WorkerResultMessage {
  type: 'result';
  layout: MSDFLayout;
}

export interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

export interface WorkerReadyMessage {
  type: 'ready';
}

export type WorkerOutMessage =
  | WorkerAtlasMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerReadyMessage;

// ============================================================================
// Atlas filename helper (mirrors converter.ts generateAtlasName)
// ============================================================================

function generateAtlasName(fontName: string, index: number, count: number): string {
  return count > 1 ? `${fontName}-${index}.png` : `${fontName}.png`;
}

// ============================================================================
// Core conversion logic — exported for direct testing
// ============================================================================

/**
 * Runs the full MSDF pipeline for a single font.
 * Emits each atlas image via `onAtlas` as soon as it is rendered, allowing
 * the caller to write it to disk and release the buffer before the next atlas
 * is created.  This keeps peak memory at O(1 atlas) rather than O(N atlases).
 */
export function runConversion(
  gen: Msdfgen,
  fontBuffer: Uint8Array,
  fontName: string,
  options: ConvertJobOptions,
  onAtlas: (filename: string, texture: Uint8Array, index: number, total: number) => void,
): MSDFLayout {
  const charset = options.charset;
  const fontSize = options.fontSize ?? 48;
  const fieldRange = options.fieldRange ?? 4;
  const edgeColoring = options.edgeColoring ?? 'simple';
  const padding = options.padding ?? 2;
  const fixOverlaps = options.fixOverlaps ?? true;

  gen.loadFont(fontBuffer);

  const charString = resolveCharset(
    charset as string | (string | number)[] | Set<string | number> | undefined,
  );
  const codepoints = Array.from(new Set(charString), (c) => c.codePointAt(0)).filter(
    (cp): cp is number => cp !== undefined,
  );

  if (codepoints.length > 0) {
    gen.loadGlyphs(codepoints, { preprocess: fixOverlaps });
  }

  const [maxW, maxH] = options.textureSize ?? [2048, 2048];

  const bins: PackedGlyphsBin[] =
    codepoints.length > 0
      ? gen.packGlyphs(
          { size: fontSize, range: fieldRange, edgeColoring },
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

  const atlasFilenames: string[] = bins.map((_, i) => generateAtlasName(fontName, i, bins.length));

  // Render one atlas at a time — emit immediately so memory can be reclaimed
  for (let i = 0; i < bins.length; i++) {
    const texture = gen.createAtlasImage(bins[i]);
    onAtlas(atlasFilenames[i], texture, i, bins.length);
  }

  const metrics: FontMetrics = gen.metrics;
  return buildLayout(fontName, bins, metrics, atlasFilenames, fontSize, fieldRange);
}

// ============================================================================
// Layout builder (mirrors converter.ts buildLayout)
// ============================================================================

function buildLayout(
  fontName: string,
  bins: PackedGlyphsBin[],
  metrics: FontMetrics,
  atlasFilenames: string[],
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
        kernings.push({ first: glyph.unicode, second: otherGlyph.unicode, amount: round(amount) });
      }
    }
  }

  const atlasW = bins.length > 0 ? bins[0].width : 0;
  const atlasH = bins.length > 0 ? bins[0].height : 0;

  return {
    pages: atlasFilenames,
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
      pages: atlasFilenames.length,
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

// ============================================================================
// Worker thread entry point
// ============================================================================

/* v8 ignore start */
async function startWorker(): Promise<void> {
  if (!parentPort) return;

  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('msdfgen-wasm/wasm');
  const buf = await fs.readFile(wasmPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gen = await Msdfgen.create(ab);

  parentPort.postMessage({ type: 'ready' } satisfies WorkerReadyMessage);

  parentPort.on(
    'message',
    (msg: {
      type: 'convert';
      fontBuffer: Uint8Array;
      fontName: string;
      options: ConvertJobOptions;
    }) => {
      if (msg.type !== 'convert') return;
      try {
        const layout = runConversion(
          gen,
          msg.fontBuffer,
          msg.fontName,
          msg.options,
          (filename, texture, index, total) => {
            parentPort?.postMessage(
              { type: 'atlas', filename, texture, index, total } satisfies WorkerAtlasMessage,
              [texture.buffer as ArrayBuffer],
            );
          },
        );
        parentPort?.postMessage({ type: 'result', layout } satisfies WorkerResultMessage);
      } catch (e) {
        parentPort?.postMessage({
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
        } satisfies WorkerErrorMessage);
      }
    },
  );
}

startWorker().catch((e) => {
  parentPort?.postMessage({ type: 'error', message: String(e) } satisfies WorkerErrorMessage);
});
/* v8 ignore stop */
