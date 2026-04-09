import type { FontMetrics, Msdfgen, PackedGlyphsBin } from 'msdfgen-wasm';
import type { ConvertJobOptions, MSDFGlyph, MSDFLayout } from './types.js';

/**
 * Utility to round metric values to 2 decimal places based on font size.
 */
function roundMetric(val: number, fontSize: number): number {
  return Math.round(val * 100 * fontSize) / 100;
}

/**
 * Creates a single glyph entry for the MSDF layout.
 */
function createGlyphEntry(
  rect: PackedGlyphsBin['rects'][0],
  pageIdx: number,
  metrics: FontMetrics,
  fontSize: number,
): MSDFGlyph {
  const glyph = rect.glyph;
  const range = rect.msdfData.range;
  const hasSize = rect.width > 0 && rect.height > 0;

  return {
    id: glyph.unicode,
    index: glyph.index,
    char: String.fromCodePoint(glyph.unicode),
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    xoffset: hasSize ? roundMetric(glyph.left - range / 2, fontSize) : 0,
    yoffset: hasSize ? roundMetric(metrics.ascenderY - (glyph.top + range / 2), fontSize) : 0,
    xadvance: roundMetric(glyph.advance, fontSize),
    page: pageIdx,
    chnl: 15,
  };
}

/**
 * Collects kerning pairs for a glyph, suppressing PUA-mapped Arabic forms.
 */
function collectKernings(
  glyph: PackedGlyphsBin['rects'][0]['glyph'],
  kernings: MSDFLayout['kernings'],
  fontSize: number,
): void {
  /* v8 ignore start */
  for (const [otherGlyph, amount] of glyph.kerning) {
    // Suppress kerning for Arabic contextual forms (PUA mapped)
    // because BMFont renderers (like PixiJS) cannot resolve PUA IDs in text strings.
    const isPUA = (cp: number) => cp >= 0xe000 && cp <= 0xf8ff;
    if (isPUA(glyph.unicode) || isPUA(otherGlyph.unicode)) continue;

    kernings.push({
      first: glyph.unicode,
      second: otherGlyph.unicode,
      amount: roundMetric(amount, fontSize),
    });
  }
  /* v8 ignore stop */
}

/**
 * Builds an MSDFLayout from packed glyph bins and font metrics.
 * Consolidation of logic from main thread and worker thread to reduce complexity.
 */
export function buildLayout(
  fontName: string,
  bins: PackedGlyphsBin[],
  metrics: FontMetrics,
  atlasFilenames: string[],
  fontSize: number,
  fieldRange: number,
): MSDFLayout {
  const chars: MSDFGlyph[] = [];
  const kernings: MSDFLayout['kernings'] = [];

  for (let pageIdx = 0; pageIdx < bins.length; pageIdx++) {
    const bin = bins[pageIdx];
    for (const rect of bin.rects) {
      chars.push(createGlyphEntry(rect, pageIdx, metrics, fontSize));
      collectKernings(rect.glyph, kernings, fontSize);
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
      lineHeight: roundMetric(metrics.lineHeight, fontSize),
      base: roundMetric(metrics.ascenderY, fontSize),
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

/**
 * Packs glyphs into bins (atlases) based on job options.
 */
export function packBins(gen: Msdfgen, jobOptions: ConvertJobOptions): PackedGlyphsBin[] {
  if (gen.glyphs.length === 0) return [];
  const [maxW, maxH] = jobOptions.textureSize ?? [2048, 2048];
  return gen.packGlyphs(
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
  );
}
