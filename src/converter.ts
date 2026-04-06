import generateBmFont from 'msdf-bmfont-xml';
import type { GenerateOptions, MSDFLayout, MSDFResult } from './types.js';

/**
 * Core MSDF generation engine.
 * Wraps the native `msdf-bmfont-xml` package to provide a modern, Promise-based API for Node.js.
 */
class MSDFConverter {
  private options: GenerateOptions;

  /**
   * Initializes a new converter instance.
   * @param options - Default configuration for conversion tasks.
   */
  constructor(options: GenerateOptions = {}) {
    this.options = {
      charset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      fontSize: 48,
      textureSize: [512, 512],
      fieldRange: 4,
      ...options,
    };
  }

  /**
   * Performs pre-conversion initialization logic.
   * Currently a no-op for the native engine.
   */
  async initialize(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Converts a raw font buffer into a Multi-channel Signed Distance Field atlas.
   *
   * @param fontBuffer - The binary content of the font file.
   * @param fontName   - Friendly name of the font, used as the base filename for atlas pages.
   * @param options    - Per-call overrides merged over the constructor defaults.
   * @returns A promise resolving to the complete MSDF generation result.
   *
   * Design notes:
   *  - `pages[]` in the returned MSDFLayout holds filename strings (e.g. "font.png"),
   *    NOT base64 data URIs. Callers that need to write PNGs use `result.textures[]`.
   *  - The `distanceField` object carries both the BMFont-spec keys (fieldType /
   *    distanceRange) AND the PixiJS v8 aliases (type / range) so one JSON satisfies both.
   */
  async convert(
    fontBuffer: Buffer,
    fontName: string,
    options: GenerateOptions = {},
  ): Promise<MSDFResult> {
    const charset = options.charset ?? (this.options.charset as string);
    const fontSize = options.fontSize ?? this.options.fontSize;
    const textureSize = options.textureSize ?? this.options.textureSize;
    const fieldRange = options.fieldRange ?? this.options.fieldRange ?? 4;

    options.onProgress?.(0, 0, 1);

    return new Promise((resolve) => {
      // ...
      const config = {
        outputType: 'json' as const,
        filename: fontName,
        fontName,
        fontSize,
        charset: Array.isArray(charset) ? charset.join('') : charset,
        distanceRange: fieldRange,
        fieldType: 'msdf' as const,
        textureSize: (textureSize ?? [1024, 1024]) as [number, number],
        'smart-size': true,
        pot: true,
        rgba: true,
        'texture-padding': 2,
      };

      generateBmFont(fontBuffer, config, (error, textures, fontResult) => {
        if (error) {
          const message = error instanceof Error ? error.message : String(error);
          return resolve({
            success: false,
            fontName,
            error: `msdf-bmfont-xml failed: ${message}`,
          });
        }

        try {
          const fontObj = this.parseFontDescriptor(fontResult);
          const resultData = this.buildLayout(fontObj, textures, fontName, fieldRange);

          options.onProgress?.(100, 1, 1);

          resolve({
            success: true,
            fontName,
            data: resultData,
            atlases: textures.map((t, i) => ({
              filename: textures.length > 1 ? `${fontName}-${i}.png` : `${fontName}.png`,
              texture: t.texture,
            })),
            metadata: this.buildMetadata(
              charset,
              fontSize,
              textureSize,
              textures.length,
              fieldRange,
            ),
          });
        } catch (err) {
          return resolve({
            success: false,
            fontName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    });
  }

  /**
   * Batch-processes multiple fonts.
   * Unlike convert(), this method aggregates errors into the results array rather than throwing.
   */
  async convertMultiple(
    fonts: Array<{ buffer: Buffer; name: string }>,
    options: GenerateOptions = {},
  ): Promise<MSDFResult[]> {
    const results: MSDFResult[] = [];
    const total = fonts.length;

    for (let i = 0; i < total; i++) {
      try {
        const result = await this.convert(fonts[i].buffer, fonts[i].name, {
          ...options,
          onProgress: (p) => {
            const overall = ((i + p / 100) / total) * 100;
            options.onProgress?.(overall, i + 1, total);
          },
        });
        results.push(result);
      } catch (err) {
        results.push({
          success: false,
          fontName: fonts[i].name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * Parses the raw font descriptor returned by msdf-bmfont-xml.
   */
  private parseFontDescriptor(fontResult: unknown): Record<string, unknown> {
    try {
      if (typeof fontResult === 'string') {
        return JSON.parse(fontResult) as Record<string, unknown>;
      }
      if (typeof fontResult === 'object' && fontResult !== null) {
        // Handle wrapped { data: '...' } or direct object
        const maybeData = (fontResult as { data?: unknown }).data;
        if (maybeData) {
          return typeof maybeData === 'string'
            ? (JSON.parse(maybeData) as Record<string, unknown>)
            : (maybeData as Record<string, unknown>);
        }
        return fontResult as Record<string, unknown>;
      }
      throw new Error('Unsupported font descriptor format');
    } catch (err) {
      if (err instanceof Error && err.message === 'Unsupported font descriptor format') {
        throw err;
      }
      throw new Error('msdf-bmfont-xml returned unparseable font descriptor');
    }
  }

  /**
   * Maps the raw BMFont data to a compliant MSDF layout descriptor.
   */
  private buildLayout(
    fontObj: Record<string, unknown>,
    textures: Array<{ filename: string; texture: Buffer }>,
    _fontName: string,
    fieldRange: number,
  ): MSDFLayout {
    const pageFilenames = textures.map((_, i) =>
      textures.length > 1 ? `${_fontName}-${i}.png` : `${_fontName}.png`,
    );

    return {
      info: (fontObj.info as MSDFLayout['info']) ?? ({} as MSDFLayout['info']),
      common: (fontObj.common as MSDFLayout['common']) ?? ({} as MSDFLayout['common']),
      chars: (fontObj.chars as MSDFLayout['chars']) ?? [],
      kernings:
        (fontObj.kernings as MSDFLayout['kernings']) ??
        (fontObj.kerning as MSDFLayout['kernings']) ??
        [],
      pages: pageFilenames,

      distanceField: {
        fieldType: 'msdf',
        distanceRange: fieldRange,
        type: 'msdf',
        range: fieldRange,
      },
    };
  }

  /**
   * Builds metadata for the generation task.
   */
  private buildMetadata(
    charset: string | string[],
    fontSize: number | undefined,
    textureSize: [number, number] | null | undefined,
    atlasCount: number,
    fieldRange: number,
  ) {
    return {
      charset: (Array.isArray(charset) ? charset.join('') : charset).length,
      fontSize: fontSize ?? 48,
      textureSize: (textureSize ?? [1024, 1024]) as [number, number],
      atlasCount,
      fieldRange,
      generatedAt: new Date().toISOString(),
      engine: 'msdf-bmfont-xml',
    };
  }

  /**
   * Releases resources allocated to the converter.
   */
  async dispose(): Promise<void> {
    return Promise.resolve();
  }
}

export default MSDFConverter;
