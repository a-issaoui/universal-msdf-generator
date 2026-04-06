import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MSDFResult, OutputFormat } from './types.js';

/**
 * Utility functions for charset management and file persistence.
 * All methods are module-level functions exposed as static members of MSDFUtils
 * for backwards-compatibility with callers that reference them via the class.
 */

// ---------------------------------------------------------------------------
// Charset helpers
// ---------------------------------------------------------------------------

/**
 * Returns a map of built-in charset names to their expanded character strings.
 * The `custom` entry accepts a string and returns its individual characters.
 */
function getCharsets(): Record<string, string | ((chars: string) => string[])> {
  return {
    ascii: getASCIICharset(),
    alphanumeric: getAlphanumericCharset(),
    latin: getLatinCharset(),
    cyrillic: getCyrillicCharset(),
    custom: (chars: string) => chars.split(''),
  };
}

/** Standard printable ASCII characters (codepoints 32–126). */
function getASCIICharset(): string {
  const chars: string[] = [];
  for (let i = 32; i < 127; i++) {
    chars.push(String.fromCharCode(i));
  }
  return chars.join('');
}

/** Basic alphanumeric set: A–Z, a–z, 0–9. */
function getAlphanumericCharset(): string {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
}

/** Extended Latin set: ASCII + common accented letters. */
function getLatinCharset(): string {
  return `${getASCIICharset()}ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ`;
}

/** Standard Cyrillic character set. */
function getCyrillicCharset(): string {
  return 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
}

/**
 * Resolves a charset option (preset name, raw string, or array) to its final character string.
 *
 * This is the single authority for charset resolution — the generator and the CLI
 * both funnel through here so that `-c ascii` produces the full 95-character ASCII
 * set rather than the literal four characters "a", "s", "c", "i".
 */
function resolveCharset(charset: string | string[] | undefined): string {
  if (!charset) return getAlphanumericCharset();

  if (Array.isArray(charset)) return charset.join('');

  const presets = getCharsets();
  if (charset in presets) {
    const entry = presets[charset];
    return typeof entry === 'function' ? entry('').join('') : entry;
  }

  // Raw string — use as-is
  return charset;
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/**
 * Performs basic validation on a font buffer signature.
 * @throws Error if the buffer is empty.
 * @returns true when the buffer looks like a known font format.
 */
function validateFontBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length === 0) {
    throw new Error('Font buffer is empty');
  }

  const signature = buffer.subarray(0, 4).toString('hex');
  const validSignatures = [
    '00010000', // TrueType
    '4f54544f', // OpenType (OTTO)
    '774f4632', // WOFF2
    '774f4646', // WOFF
  ];

  if (!validSignatures.some((sig) => signature.startsWith(sig))) {
    console.warn('Font buffer signature might not be valid. Expected TTF/OTF/WOFF/WOFF2 format.');
  }

  return true;
}

/**
 * Persists MSDF generation results to the local filesystem.
 *
 * PNG atlases are ALWAYS written to disk so that the saved JSON layout file can
 * reference them by filename (e.g. "font.png") rather than embedding raw base64.
 * Embedding base64 in JSON would make the file ~33% larger and incompatible with
 * standard loaders such as PixiJS and Three.js that resolve page filenames relative
 * to the JSON path.
 *
 * @param result    - The in-memory generation result from MSDFConverter.
 * @param outputDir - Target directory.
 * @param options   - Naming and format overrides.
 * @returns Absolute paths of every written file.
 */
async function saveMSDFOutput(
  result: MSDFResult,
  outputDir: string,
  options: { filename?: string; format?: OutputFormat } = {},
): Promise<string[]> {
  if (!result.success || result.cached) return [];

  const dir = path.resolve(outputDir);
  const filename = options.filename || result.fontName || 'msdf-font';
  const format: OutputFormat = options.format ?? 'json';

  await fs.mkdir(dir, { recursive: true });

  const outputs: string[] = [];

  // Write files based on the requested format and results
  await writeTextures(result, dir, outputs);

  await writeJsonLayout(result, dir, filename, format, outputs);
  await writeXmlLayout(result, dir, filename, format, outputs);
  await writeMetadata(result, dir, filename, outputs);

  return outputs;
}

/**
 * Persists PNG atlas files to disk.
 * Always writes PNGs regardless of format so that JSON page references resolve correctly.
 */
async function writeTextures(
  result: import('./types.js').MSDFSuccess,
  dir: string,
  outputs: string[],
): Promise<void> {
  if (!result.atlases || result.atlases.length === 0) return;

  for (const atlas of result.atlases) {
    const texPath = path.join(dir, atlas.filename);
    await fs.writeFile(texPath, atlas.texture);
    outputs.push(texPath);
  }
}

/**
 * Persists the JSON layout file to disk.
 */
async function writeJsonLayout(
  result: import('./types.js').MSDFSuccess,
  dir: string,
  filename: string,
  format: OutputFormat,
  outputs: string[],
): Promise<void> {
  if (format === 'json' || format === 'both' || format === 'all') {
    const jsonPath = path.join(dir, `${filename}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(result.data, null, 2));
    outputs.push(jsonPath);
  }
}

/**
 * Persists the AngelCode XML (.fnt) layout file to disk.
 */
async function writeXmlLayout(
  result: import('./types.js').MSDFSuccess,
  dir: string,
  filename: string,
  format: OutputFormat,
  outputs: string[],
): Promise<void> {
  if (result.xml && (format === 'fnt' || format === 'both' || format === 'all')) {
    const fntPath = path.join(dir, `${filename}.fnt`);
    await fs.writeFile(fntPath, result.xml);
    outputs.push(fntPath);
  }
}

/**
 * Persists the metadata sidecar file to disk.
 */
async function writeMetadata(
  result: import('./types.js').MSDFSuccess,
  dir: string,
  filename: string,
  outputs: string[],
): Promise<void> {
  const metaPath = path.join(dir, `${filename}-meta.json`);
  await fs.writeFile(metaPath, JSON.stringify(result.metadata, null, 2));
  outputs.push(metaPath);
}

/**
 * Checks whether MSDF assets for a given identity already exist on disk.
 */
async function checkMSDFOutputExists(
  outputDir: string,
  identity: string,
  options: { format?: OutputFormat } = {},
): Promise<boolean> {
  const files = getExpectedFiles(outputDir, identity, options.format ?? 'json');
  try {
    await Promise.all(files.map((f) => fs.access(f)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the list of filenames expected for a specific generation identity and format.
 * PNG is always included because we always write atlas textures to disk.
 */
function getExpectedFiles(
  outputDir: string,
  identity: string,
  format: OutputFormat = 'json',
): string[] {
  const dir = path.resolve(outputDir);
  const files: string[] = [];

  // PNG is always expected — see saveMSDFOutput comment above.
  files.push(path.join(dir, `${identity}.png`));

  if (format === 'json' || format === 'both' || format === 'all') {
    files.push(path.join(dir, `${identity}.json`));
  }

  if (format === 'fnt' || format === 'both' || format === 'all') {
    files.push(path.join(dir, `${identity}.fnt`));
  }

  files.push(path.join(dir, `${identity}-meta.json`));
  return files;
}

/**
 * Returns a progress callback that writes percentage updates to stdout.
 */
function createProgressCallback(
  verbose = true,
): (progress: number, completed: number, total: number) => void {
  let lastProgress = 0;

  return (progress: number, completed: number, total: number) => {
    const rounded = Math.round(progress);

    if (verbose && rounded > lastProgress) {
      process.stdout.write(`\rProgress: ${rounded}% (${completed}/${total})`);
      lastProgress = rounded;
    }

    if (completed === total && verbose) {
      process.stdout.write('\n');
    }
  };
}

// ---------------------------------------------------------------------------
// Legacy / deprecated helpers
// ---------------------------------------------------------------------------

/**
 * Heuristically calculates a power-of-two atlas texture size.
 *
 * @deprecated The generator uses the native `smart-size` + `pot` options from
 * msdf-bmfont-xml which produce better results. This helper is retained only
 * for external callers that may depend on it; it will be removed in a future
 * major version.
 */
function calculateOptimalTextureSize(charCount: number, fontSize: number): [number, number] {
  const area = charCount * (fontSize * fontSize) * 1.2;
  const size = Math.ceil(Math.sqrt(area));
  const pot = 2 ** Math.ceil(Math.log2(size));
  const capped = Math.min(Math.max(pot, 64), 4096);
  return [capped, capped];
}

// ---------------------------------------------------------------------------
// Namespace export (static-class façade for backwards compatibility)
// ---------------------------------------------------------------------------

/**
 * MSDFUtils exposes the utility functions as static methods.
 *
 * Implementation note: these are plain module-level functions grouped under a
 * class namespace solely for API compatibility. Biome's `noStaticOnlyClass` rule
 * is intentionally disabled for this file; prefer the named function exports for
 * new code.
 */
class MSDFUtils {
  static getCharsets = getCharsets;
  static getASCIICharset = getASCIICharset;
  static getAlphanumericCharset = getAlphanumericCharset;
  static getLatinCharset = getLatinCharset;
  static getCyrillicCharset = getCyrillicCharset;
  static resolveCharset = resolveCharset;
  static validateFontBuffer = validateFontBuffer;
  static saveMSDFOutput = saveMSDFOutput;
  static checkMSDFOutputExists = checkMSDFOutputExists;
  static getExpectedFiles = getExpectedFiles;
  static createProgressCallback = createProgressCallback;
  static writeTextures = writeTextures;
  static writeJsonLayout = writeJsonLayout;
  static writeXmlLayout = writeXmlLayout;
  static writeMetadata = writeMetadata;
  /**
   * @deprecated Use the native `smart-size` + `pot` generator options instead.
   */
  static calculateOptimalTextureSize = calculateOptimalTextureSize;
}

export {
  calculateOptimalTextureSize,
  checkMSDFOutputExists,
  createProgressCallback,
  getAlphanumericCharset,
  getASCIICharset,
  getCharsets,
  getCyrillicCharset,
  getExpectedFiles,
  getLatinCharset,
  resolveCharset,
  saveMSDFOutput,
  validateFontBuffer,
  writeJsonLayout,
  writeMetadata,
  writeTextures,
  writeXmlLayout,
};

export default MSDFUtils;
