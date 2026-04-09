import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MSDFLayout, MSDFResult, MSDFSuccess, OutputFormat } from './types.js';

// ---------------------------------------------------------------------------
// File System Utils
// ---------------------------------------------------------------------------

/**
 * Generates an atlas filename based on texture count.
 */
export function generateAtlasName(fontName: string, index: number, count: number): string {
  return count > 1 ? `${fontName}-${index}.png` : `${fontName}.png`;
}

/**
 * Validates a font buffer by checking magic bytes.
 */
function validateFontBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) return false;
  const magic = buffer.toString('hex', 0, 4);
  // TrueType (00010000), OpenType (4f54544f), WOFF (774f4646), WOFF2 (774f4632)
  return ['00010000', '4f54544f', '774f4646', '774f4632'].includes(magic);
}

/**
 * Saves MSDF generation results to the specified directory.
 */
async function saveMSDFOutput(
  result: MSDFResult,
  outputDir: string,
  options: { filename?: string; format?: OutputFormat; skipTextures?: boolean } = {},
): Promise<string[]> {
  if (!result.success || result.cached) return [];
  const res = result as MSDFSuccess;

  const dir = path.resolve(outputDir);
  await fs.mkdir(dir, { recursive: true });

  const filename = options.filename || res.fontName || 'font';
  const format = options.format || 'json';

  const outputs: string[] = [];

  // 1. Save Textures (skipped when streaming mode already wrote them)
  if (!options.skipTextures) {
    const texturePaths = await writeTextures(res, dir, filename);
    outputs.push(...texturePaths);
  }

  // 2. Save JSON Layout
  if (format === 'json' || format === 'both' || format === 'all') {
    const jsonPath = await writeJsonLayout(res.data, dir, filename);
    outputs.push(jsonPath);
  }

  // 3. Save XML (FNT) Layout
  if (res.xml && (format === 'fnt' || format === 'both' || format === 'all')) {
    const fntPath = await writeXmlLayout(res.xml, dir, filename);
    outputs.push(fntPath);
  }

  // 4. Save Metadata Sidecar (for smart re-use)
  const metaPath = await writeMetadata(res, dir, filename);
  outputs.push(metaPath);

  return outputs;
}

async function writeTextures(
  result: MSDFSuccess,
  dir: string,
  filename: string,
): Promise<string[]> {
  if (!result.atlases || result.atlases.length === 0) return [];
  const paths: string[] = [];

  for (let i = 0; i < result.atlases.length; i++) {
    const atlas = result.atlases[i];
    const name = result.atlases.length > 1 ? `${filename}-${i}.png` : `${filename}.png`;
    const p = path.join(dir, name);
    await fs.writeFile(p, atlas.texture);
    paths.push(p);
  }
  return paths;
}

async function writeJsonLayout(data: MSDFLayout, dir: string, filename: string): Promise<string> {
  const p = path.join(dir, `${filename}.json`);
  await fs.writeFile(p, JSON.stringify(data, null, 2));
  return p;
}

async function writeXmlLayout(xml: string, dir: string, filename: string): Promise<string> {
  const p = path.join(dir, `${filename}.fnt`);
  await fs.writeFile(p, xml);
  return p;
}

async function writeMetadata(result: MSDFSuccess, dir: string, filename: string): Promise<string> {
  const p = path.join(dir, `${filename}-meta.json`);
  const meta = {
    ...result.metadata,
    atlasCount: result.atlases.length,
    version: '1.0',
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(p, JSON.stringify(meta, null, 2));
  return p;
}

async function checkMSDFOutputExists(
  outputDir: string,
  identity: string,
  options: { format?: OutputFormat; verbose?: boolean } = {},
): Promise<boolean> {
  const meta = await loadMetadata(outputDir, identity);
  if (!meta || meta.version !== '1.0') return false;

  const atlasCount = meta.atlasCount || 1;
  const files = getExpectedFiles(outputDir, identity, options.format ?? 'json', atlasCount);

  // Integrity check: Ensure all files exist synchronously-ish
  const results = await Promise.allSettled(files.map((f) => fs.access(f)));
  const allExist = results.every((r) => r.status === 'fulfilled');

  if (allExist && options.verbose) {
    console.log(`✨ Re-using MSDF: ${identity} (${atlasCount} atlases)`);
  }

  return allExist;
}

/**
 * Loads and parses the metadata sidecar for a font identity.
 */
async function loadMetadata(
  outputDir: string,
  identity: string,
): Promise<{ version: string; atlasCount?: number } | null> {
  const dir = path.resolve(outputDir);
  const metaPath = path.join(dir, `${identity}-meta.json`);
  try {
    const metaStr = await fs.readFile(metaPath, 'utf8');
    return JSON.parse(metaStr);
  } catch {
    return null;
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
  atlasCount = 1,
): string[] {
  const dir = path.resolve(outputDir);
  const files = [path.join(dir, `${identity}-meta.json`)];

  // Identifies atlas names (e.g., "font.png" or "font-0.png", "font-1.png")
  if (atlasCount <= 1) {
    files.push(path.join(dir, `${identity}.png`));
  } else {
    for (let i = 0; i < atlasCount; i++) {
      files.push(path.join(dir, `${identity}-${i}.png`));
    }
  }

  if (format === 'json' || format === 'both' || format === 'all') {
    files.push(path.join(dir, `${identity}.json`));
  }
  if (format === 'fnt' || format === 'both' || format === 'all') {
    files.push(path.join(dir, `${identity}.fnt`));
  }
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
// Charset Management
// ---------------------------------------------------------------------------

let _arabicCache: string | null = null;
const COMMON_CHARSETS = {
  ascii: () => Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join(''),
  alphanumeric: () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  latin: () =>
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ',
  cyrillic: () =>
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя',
  arabic: () => {
    if (_arabicCache) return _arabicCache;
    // 36 Arabic letters (including common variants like Alef with Hamza)
    const letters =
      '\u0621\u0622\u0623\u0624\u0625\u0626\u0627\u0628\u0629\u062A' +
      '\u062B\u062C\u062D\u062E\u062F\u0630\u0631\u0632\u0633\u0634' +
      '\u0635\u0636\u0637\u0638\u0639\u063A\u0641\u0642\u0643\u0644' +
      '\u0645\u0646\u0647\u0648\u0649\u064A';
    // Arabic-Indic numerals (U+0660–U+0669)
    const numerals = '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669';
    // Tashkil diacritics (Fathah, Dammah, Kasrah, Sukun, Shaddah + Tanwin forms)
    const tashkil = '\u064B\u064C\u064D\u064E\u064F\u0650\u0651\u0652\u0653\u0654\u0655';
    // Tatweel/Kashida elongation mark (repeated by renderer for justification)
    const tatweel = '\u0640';
    // Common punctuation
    const punctuation = '\u060C\u061B\u061F\u0021\u002E\u003A\u0028\u0029';
    _arabicCache = letters + numerals + tashkil + tatweel + punctuation;
    return _arabicCache;
  },

  // Persian: Arabic + 4 Farsi-specific letters + Eastern Arabic numerals
  persian: () =>
    COMMON_CHARSETS.arabic() +
    '\u067E\u0686\u0698\u06AF\u06CC' + // پ چ ژ گ ی (Persian Yeh)
    '\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9', // ۰–۹

  // Urdu: Persian + Urdu-specific letters
  urdu: () => `${COMMON_CHARSETS.persian()}\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06C2\u06D2\u06D3`,

  // Hebrew: 27 consonants + 5 final forms + Niqqud vowel points
  hebrew: () => {
    const consonants = Array.from({ length: 27 }, (_, i) => String.fromCodePoint(0x05d0 + i)).join(
      '',
    );
    const niqqud =
      '\u05B0\u05B1\u05B2\u05B3\u05B4\u05B5\u05B6\u05B7\u05B8\u05B9\u05BB\u05BC\u05BD\u05BF\u05C1\u05C2';
    return consonants + niqqud;
  },
  custom: (chars: string) => chars.split(''),
};
const CHARSET_CACHE = new Map<string, string>();
function resolveStringCharset(c: string): string {
  if (c === 'ascii') return COMMON_CHARSETS.ascii();
  if (c === 'alphanumeric') return COMMON_CHARSETS.alphanumeric();
  if (c === 'latin') return COMMON_CHARSETS.latin();
  if (c === 'cyrillic') return COMMON_CHARSETS.cyrillic();
  if (c === 'arabic') return COMMON_CHARSETS.arabic();
  if (c === 'persian') return COMMON_CHARSETS.persian();
  if (c === 'urdu') return COMMON_CHARSETS.urdu();
  if (c === 'hebrew') return COMMON_CHARSETS.hebrew();
  if (c === 'custom') {
    throw new Error('"custom" is a custom charset provider, not a preset name.');
  }
  return c;
}

function resolveCharset(
  c: string | (string | number)[] | Set<string | number> | undefined,
): string {
  let cacheKey: string;
  if (!c) cacheKey = 'default-latin';
  else if (typeof c === 'string') cacheKey = c;
  else if (Array.isArray(c)) {
    const sorted = [...c].sort();
    cacheKey = `arr:${JSON.stringify(sorted)}`;
  } else if (c instanceof Set) {
    const sorted = Array.from(c).sort();
    cacheKey = `set:${JSON.stringify(sorted)}`;
  } else cacheKey = String(c);

  const cached = CHARSET_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: string;
  if (!c) {
    result = COMMON_CHARSETS.latin();
  } else if (typeof c === 'string') {
    result = resolveStringCharset(c);
  } else if (Array.isArray(c)) {
    result = (c as (string | number)[])
      .map((item) => (typeof item === 'number' ? String.fromCodePoint(item) : item))
      .join('');
  } else if (c instanceof Set) {
    result = Array.from(c)
      .map((item) => (typeof item === 'number' ? String.fromCodePoint(item) : item))
      .join('');
  } else {
    result = String(c);
  }

  CHARSET_CACHE.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Math & Layout
// ---------------------------------------------------------------------------

function calculateOptimalTextureSize(charCount: number, fontSize: number): [number, number] {
  const areaPerChar = fontSize * fontSize * 1.2;
  const totalArea = charCount * areaPerChar;
  const side = Math.sqrt(totalArea);

  let size = 512;
  while (size < side && size < 4096) {
    size *= 2;
  }

  return [size, size];
}

// ---------------------------------------------------------------------------
// MSDFUtils Façade
// ---------------------------------------------------------------------------

/**
 * Static utility bundle for MSDF operations.
 */
class MSDFUtils {
  static validateFontBuffer = validateFontBuffer;
  static saveMSDFOutput = saveMSDFOutput;
  static checkMSDFOutputExists = checkMSDFOutputExists;
  static loadMetadata = loadMetadata;
  static getExpectedFiles = getExpectedFiles;
  static createProgressCallback = createProgressCallback;
  static calculateOptimalTextureSize = calculateOptimalTextureSize;

  static getCharsets = () => COMMON_CHARSETS;
  static getASCIICharset = () => COMMON_CHARSETS.ascii();
  static getAlphanumericCharset = () => COMMON_CHARSETS.alphanumeric();
  static getLatinCharset = () => COMMON_CHARSETS.latin();
  static getCyrillicCharset = () => COMMON_CHARSETS.cyrillic();
  static resolveCharset = resolveCharset;

  // Internal helpers exposed for testing
  /** @internal */
  static _writeTextures = writeTextures;
  /** @internal */
  static _writeJsonLayout = writeJsonLayout;
  /** @internal */
  static _writeXmlLayout = writeXmlLayout;
  /** @internal */
  static _writeMetadata = writeMetadata;
}

export {
  calculateOptimalTextureSize,
  checkMSDFOutputExists,
  createProgressCallback,
  getExpectedFiles,
  loadMetadata,
  resolveCharset,
  saveMSDFOutput,
  validateFontBuffer,
};

export default MSDFUtils;
