/**
 * converter-worker.ts
 * Worker thread for MSDF generation. Runs one persistent Msdfgen WASM instance
 * and processes conversion jobs via message passing.
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import type { FontMetrics } from 'msdfgen-wasm';
import { Msdfgen } from 'msdfgen-wasm';
import { appendUnicodeGlyphs, loadGlyphsByIds } from './glyph-loader.js';
import { buildLayout, packBins } from './layout-utils.js';
import { analyzeCharset } from './script-detector.js';
import { getRequiredGlyphIds, SCRIPT_DEFAULT_LANGUAGE, type ShapingOptions } from './shaper.js';
import type { MSDFLayout } from './types.js';
import { generateAtlasName, resolveCharset } from './utils.js';

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
  complexShaping?: boolean;
  shapingText?: string;
  script?: string;
  direction?: 'ltr' | 'rtl';
  language?: string;
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
  shapingEngine?: 'harfbuzz' | 'none';
  glyphIdMap?: Record<number, number>;
  shapedText?: string;
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

// ── Core conversion logic ──

// ============================================================================
// Core conversion logic
// ============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: intentional — full shaping+packing pipeline in one pass
export async function runConversion(
  gen: Msdfgen,
  fontBuffer: Uint8Array,
  fontName: string,
  options: ConvertJobOptions,
  onAtlas: (filename: string, texture: Uint8Array, index: number, total: number) => void,
): Promise<{
  layout: MSDFLayout;
  shapingEngine: 'harfbuzz' | 'none';
  glyphIdMap?: Record<number, number>;
  shapedText?: string;
}> {
  const charset = options.charset;
  const fontSize = options.fontSize ?? 48;
  const fieldRange = options.fieldRange ?? 4;
  const fixOverlaps = options.fixOverlaps ?? true;

  gen.loadFont(fontBuffer);

  const charString = resolveCharset(
    charset as string | (string | number)[] | Set<string | number> | undefined,
  );

  let glyphIdMap: Record<number, number> | undefined;
  let glyphIdToAdvance: Map<number, number> | undefined;
  let shapingEngine: 'harfbuzz' | 'none' = 'none';
  let shapedText: string | undefined;
  let shapingUpem = 1000;

  // 1. Character Retrieval & Shaping
  if (options.complexShaping) {
    const shapingInput = options.shapingText ?? charString;
    const analysis = analyzeCharset(shapingInput);
    const shapingOpts: ShapingOptions = {
      direction:
        (options.direction as 'rtl' | 'ltr') ??
        (analysis.hasRtl ? 'rtl' : analysis.primaryDirection),
      script: analysis.primaryScript ?? 'Arab',
      language:
        options.language ?? SCRIPT_DEFAULT_LANGUAGE[analysis.primaryScript ?? 'Arab'] ?? 'en',
    };

    const shaperResult = await getRequiredGlyphIds(
      shapingInput,
      Buffer.from(fontBuffer),
      shapingOpts,
    );

    const loaderResult = loadGlyphsByIds(
      gen,
      shaperResult.glyphIds,
      shaperResult.glyphIdToCodepoint,
      {
        preprocess: fixOverlaps,
        advances: shaperResult.glyphIdToAdvance,
      },
    );

    glyphIdMap = Object.fromEntries(loaderResult.glyphIdToUnicode);
    glyphIdToAdvance = shaperResult.glyphIdToAdvance;
    shapingEngine = 'harfbuzz';
    shapingUpem = shaperResult.upem;
    shapedText = shaperResult.shapedGlyphIds
      .map((id) => {
        const unicode = loaderResult.glyphIdToUnicode.get(id);
        return unicode ? String.fromCodePoint(unicode) : '';
      })
      .join('');

    // Load any non-shaping text (mixed scripts)
    if (options.shapingText && options.shapingText !== charString) {
      const shapingCps = new Set(
        Array.from(shapingInput, (c) => c.codePointAt(0)).filter(
          (cp): cp is number => cp !== undefined,
        ),
      );
      const remainingCps = Array.from(new Set(charString), (c) => c.codePointAt(0)).filter(
        (cp): cp is number => cp !== undefined && !shapingCps.has(cp),
      );
      if (remainingCps.length > 0) {
        appendUnicodeGlyphs(gen, remainingCps, { preprocess: fixOverlaps });
      }
    }
  } else {
    const codepoints = Array.from(new Set(charString), (c) => c.codePointAt(0)).filter(
      (cp): cp is number => cp !== undefined,
    );
    if (codepoints.length > 0) {
      gen.loadGlyphs(codepoints, { preprocess: fixOverlaps });
    }
  }

  // 2. Packing
  const bins = packBins(gen, options);
  const atlasFilenames: string[] = bins.map((_, i) => generateAtlasName(fontName, i, bins.length));

  // 3. Rendering Atlases (Incremental for low memory)
  for (let i = 0; i < bins.length; i++) {
    const texture = gen.createAtlasImage(bins[i]);
    onAtlas(atlasFilenames[i], texture, i, bins.length);
  }

  // 4. Build Layout Data
  const metrics: FontMetrics = gen.metrics;
  const layout = buildLayout(fontName, bins, metrics, atlasFilenames, fontSize, fieldRange);

  // 5. Precision Layout Correction (Final override for seamless merging)
  if (glyphIdToAdvance && glyphIdMap) {
    for (const char of layout.chars) {
      const glyphIdStr = Object.entries(glyphIdMap).find(([_gid, u]) => u === char.id)?.[0];
      if (glyphIdStr !== undefined) {
        const adv = glyphIdToAdvance.get(Number.parseInt(glyphIdStr, 10));
        if (adv !== undefined) {
          const scale = fontSize / shapingUpem;
          char.xadvance = adv * scale;
        }
      }
    }
  }

  return { layout, shapingEngine, glyphIdMap, shapedText };
}

// ============================================================================
// Worker thread entry point
// ============================================================================

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
    async (msg: {
      type: 'convert';
      fontBuffer: Uint8Array;
      fontName: string;
      options: ConvertJobOptions;
    }) => {
      if (msg.type !== 'convert') return;
      try {
        const { layout, shapingEngine, glyphIdMap, shapedText } = await runConversion(
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
        parentPort?.postMessage({
          type: 'result',
          layout,
          shapingEngine,
          glyphIdMap,
          shapedText,
        } satisfies WorkerResultMessage);
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
