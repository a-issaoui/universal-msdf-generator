/**
 * Interface representing a single glyph in the MSDF layout.
 */
export interface MSDFGlyph {
  /** ASCII or Unicode ID */
  id: number;
  /** Index in the font */
  index: number;
  /** The character string */
  char: string;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** X offset for rendering */
  xoffset: number;
  /** Y offset for rendering */
  yoffset: number;
  /** Advance width */
  xadvance: number;
  /** Channel information */
  chnl: number;
  /** X position in the atlas */
  x: number;
  /** Y position in the atlas */
  y: number;
  /** Page index in the atlas */
  page: number;
}

/**
 * Interface representing the complete MSDF layout data (BMFont format).
 * The `pages` field holds filename strings (e.g. "font.png"), never base64 data URIs.
 * Base64 textures are kept separately in MSDFSuccess.atlases for file persistence.
 */
export interface MSDFLayout {
  /** Filenames of atlas pages, e.g. ["font.png"] — NOT base64 data URIs. */
  pages: string[];
  chars: MSDFGlyph[];
  info: {
    face: string;
    size: number;
    bold: number;
    italic: number;
    charset: string[];
    unicode: number;
    stretchH: number;
    smooth: number;
    aa: number;
    padding: [number, number, number, number];
    spacing: [number, number];
    outline: number;
  };
  common: {
    lineHeight: number;
    base: number;
    scaleW: number;
    scaleH: number;
    pages: number;
    packed: number;
    alphaChnl: number;
    redChnl: number;
    greenChnl: number;
    blueChnl: number;
  };
  distanceField: {
    fieldType: string;
    distanceRange: number;
    /** Fallback key for PixiJS v8 compatibility */
    type?: string;
    /** Fallback key for PixiJS v8 compatibility */
    range?: number;
  };
  kernings: Array<{
    first: number;
    second: number;
    amount: number;
  }>;
}

/**
 * Sources from which a font can be loaded.
 */
export type FontSource = string | URL | Buffer | ArrayBuffer | ArrayBufferView;

/**
 * Configuration for a pre-defined or custom charset.
 */
export interface CharsetOption {
  /** The characters to include in the atlas */
  chars: string;
  /** Friendly name for the charset */
  name: string;
}

/**
 * Supported charset category names.
 */
export type CharsetName = 'ascii' | 'alphanumeric' | 'latin' | 'cyrillic' | 'custom';

/**
 * Supported output formats.
 * - `json`  — BMFont JSON layout + embedded PNG written separately (default).
 * - `fnt`   — AngelCode XML (.fnt) + PNG atlas files.
 * - `both`  — Both JSON and .fnt outputs.
 * - `all`   — Alias for `both`.
 *
 * Note: `binary` is intentionally absent — not yet implemented.
 */
export type OutputFormat = 'json' | 'fnt' | 'both' | 'all';

/**
 * Global configuration for the MSDF generation process.
 */
export interface GenerateOptions {
  /** Charset preset name or raw character string */
  charset?: CharsetName | string | string[];
  /** Base font size for generation */
  fontSize?: number;
  /** Atlas texture dimensions [width, height] */
  textureSize?: [number, number] | null;
  /** Range of the distance field in pixels */
  fieldRange?: number;
  /**
   * Edge coloring algorithm used during MSDF computation.
   * - `simple`   — fast, good for most fonts (default)
   * - `inktrap`  — reduces artifacts on complex/decorative glyphs
   * - `distance` — better gradient smoothness for certain typefaces
   */
  edgeColoring?: 'simple' | 'inktrap' | 'distance';
  /**
   * Padding in pixels between glyphs in the atlas.
   * Prevents bleeding at atlas borders and is required for correct mipmapping.
   * Default: 2.
   */
  padding?: number;
  /** Whether to attempt fixing overlapping glyph paths */
  fixOverlaps?: boolean;
  /** Friendly name for the output file (if not provided, a slug derived from the font name is used) */
  name?: string;
  /** Optional font weight (e.g., '400', '700', 'bold') */
  weight?: string;
  /** Optional font style (e.g., 'normal', 'italic') */
  style?: string;
  /** Directory where results will be saved */
  outputDir?: string;
  /** Desired output format */
  outputFormat?: OutputFormat;
  /** Skip generation if target files already exist in outputDir */
  reuseExisting?: boolean;
  /** Force re-generation even if target files exist (overrides reuseExisting) */
  force?: boolean;
  /** Enable detailed logging */
  verbose?: boolean;
  /** Progress callback handler */
  onProgress?: (progress: number, completed: number, total: number) => void;
  /** Max ms to wait for MSDF generation before rejecting. Default: 60000. */
  generationTimeout?: number;
  /** Max concurrent fonts when using generateMultiple. Default: unlimited. */
  concurrency?: number;
}

/**
 * Internal representation of font metadata and content.
 */
export interface FontData {
  /** Raw font binary data */
  buffer: Buffer;
  /** Font family name */
  name: string;
  /** Optional font weight (e.g., '400') */
  weight?: string;
  /** Optional font style (e.g., 'italic') */
  style?: string;
  /** Font format (e.g., 'ttf') */
  format?: string;
  /** Origin of the font data */
  source: 'google' | 'url' | 'local' | 'buffer';
  /** Local path if sourced from file */
  path?: string;
  /** Original source URL if applicable */
  originalUrl?: string;
}

/**
 * Result object returned when MSDF generation succeeds and data is in memory.
 */
export interface MSDFSuccess {
  success: true;
  /** Indicates the result came from in-memory generation, not disk cache. */
  cached?: false;
  /** Family name of the generated font */
  fontName: string;
  /** Detailed glyph and layout data (pages[] holds filenames, not base64 URIs) */
  data: MSDFLayout;
  /** AngelCode XML string (.fnt) — only populated when outputFormat includes 'fnt' */
  xml?: string;
  /** Raw PNG texture buffers for file persistence */
  atlases: Array<{ filename: string; texture: Buffer }>;
  /** Configuration used for generation */
  metadata: {
    charset: number;
    fontSize: number;
    textureSize: [number, number];
    atlasCount: number;
    fieldRange: number;
    generatedAt: string;
    engine: string;
  };

  /** List of absolute paths to saved files */
  savedFiles?: string[];
}

/**
 * Result object returned when MSDF output already exists on disk (cache hit).
 * `data` is NOT populated — load files from `savedFiles` instead.
 */
export interface MSDFCachedSuccess {
  success: true;
  cached: true;
  fontName: string;
  metadata: {
    charset: number;
    fontSize: number;
    textureSize: [number, number];
    atlasCount?: number;
    fieldRange: number;
    generatedAt: string;
    engine: 'cached';
  };
  /** Absolute paths to the existing files on disk */
  savedFiles: string[];
}

/**
 * Result object returned when MSDF generation fails.
 */
export interface MSDFFailure {
  success: false;
  /** Family name of the font attempt */
  fontName: string;
  /** Error message */
  error: string;
}

/**
 * Union of all possible results from generation methods.
 */
export type MSDFResult = MSDFSuccess | MSDFCachedSuccess | MSDFFailure;

/**
 * HTTP fetch request options.
 */
export interface FetchOptions {
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Custom User-Agent header */
  userAgent?: string;
  /** AbortSignal to cancel in-flight fetch requests */
  signal?: AbortSignal;
}

/**
 * Options specific to Google Font retrieval.
 */
export interface GoogleFontOptions {
  /** Target weight */
  weight?: string;
  /** Target style */
  style?: string;
  /** Target subset (e.g., 'latin') */
  subset?: string;
  /** Target format (e.g., 'woff2') */
  format?: string;
}
