import generateBmFont from 'msdf-bmfont-xml';
import type { GenerateOptions, MSDFLayout, MSDFResult, MSDFSuccess } from './types.js';

/**
 * Generates an atlas filename based on texture count.
 */
function generateAtlasName(fontName: string, index: number, count: number): string {
  const isMulti = count > 1;
  if (isMulti) {
    return `${fontName}-${index}.png`;
  }
  return `${fontName}.png`;
}

/**
 * Core MSDF generation engine.
 */
class MSDFConverter {
  private options: GenerateOptions;

  constructor(options: GenerateOptions = {}) {
    this.options = {
      charset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      fontSize: 48,
      textureSize: [512, 512],
      fieldRange: 4,
      ...options,
    };
  }

  async initialize(): Promise<void> {
    // No-op for current engine
  }

  async convert(
    fontBuffer: Buffer,
    fontName: string,
    options: GenerateOptions = {},
  ): Promise<MSDFResult> {
    const charset = options.charset || this.options.charset;
    const fontSize = options.fontSize || this.options.fontSize;
    const textureSize = options.textureSize || this.options.textureSize;
    const fieldRange = options.fieldRange || this.options.fieldRange;

    const hasProgress = !!options.onProgress;
    if (hasProgress) {
      options.onProgress?.(0, 0, 1);
    }

    return new Promise((resolve) => {
      const config = {
        outputType: 'json' as const,
        filename: fontName,
        fontName,
        fontSize: fontSize as number,
        charset: (Array.isArray(charset) ? charset.join('') : charset) as string,
        distanceRange: fieldRange as number,
        fieldType: 'msdf' as const,
        textureSize: textureSize as [number, number],
        'smart-size': true,
        pot: true,
        rgba: true,
        'texture-padding': 2,
      };

      generateBmFont(fontBuffer, config, (error, textures, fontResult) => {
        if (error) {
          return resolve(this.handleGenError(error, fontName));
        }

        try {
          const fontObj = this.parseFontDescriptor(fontResult);
          const resultData = this.buildLayout(fontObj, textures, fontName, fieldRange as number);

          if (hasProgress) {
            options.onProgress?.(100, 1, 1);
          }

          resolve(
            this.assembleSuccess(
              fontName,
              resultData,
              textures,
              charset as string,
              fontSize as number,
              textureSize as [number, number],
              fieldRange as number,
            ),
          );
        } catch (err) {
          resolve(this.handleGenError(err, fontName));
        }
      });
    });
  }

  private handleGenError(err: unknown, fontName: string): MSDFResult {
    const isErr = err instanceof Error;
    const message = isErr ? (err as Error).message : String(err);
    const hasP = message.startsWith('msdf-bmfont-xml failed:');
    let prefix = 'msdf-bmfont-xml failed: ';
    if (hasP) {
      prefix = '';
    }
    return {
      success: false,
      fontName,
      error: `${prefix}${message}`,
    };
  }

  private assembleSuccess(
    fontName: string,
    data: MSDFLayout,
    textures: Array<{ filename: string; texture: Buffer }>,
    charset: string | string[],
    fontSize: number,
    textureSize: [number, number],
    fieldRange: number,
  ): MSDFSuccess {
    return {
      success: true,
      fontName,
      data,
      atlases: textures.map((t, i) => {
        return { filename: generateAtlasName(fontName, i, textures.length), texture: t.texture };
      }),
      metadata: this.buildMetadata(charset, fontSize, textureSize, textures.length, fieldRange),
    };
  }

  async convertMultiple(
    fonts: Array<{ buffer: Buffer; name: string }>,
    options: GenerateOptions = {},
  ): Promise<MSDFResult[]> {
    const results: MSDFResult[] = [];
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
        results.push(this.handleGenError(err, fonts[i].name));
      }
    }
    return results;
  }

  private parseFontDescriptor(fontResult: unknown): Record<string, unknown> {
    const isString = typeof fontResult === 'string';
    if (isString) {
      try {
        return JSON.parse(fontResult as string);
      } catch (_err) {
        throw new Error('msdf-bmfont-xml returned unparseable font descriptor');
      }
    }

    const isObj = !!(fontResult && typeof fontResult === 'object');
    if (isObj) {
      const maybeData = (fontResult as { data?: unknown }).data;
      if (maybeData) {
        const isDataStr = typeof maybeData === 'string';
        return isDataStr ? JSON.parse(maybeData as string) : (maybeData as Record<string, unknown>);
      }
      return fontResult as Record<string, unknown>;
    }

    throw new Error('Unsupported font descriptor format');
  }

  private buildLayout(
    fontObj: Record<string, unknown>,
    textures: Array<{ filename: string; texture: Buffer }>,
    _fontName: string,
    fieldRange: number,
  ): MSDFLayout {
    const pages = textures.map((_, i) => {
      return generateAtlasName(_fontName, i, textures.length);
    });

    const info = fontObj.info as MSDFLayout['info'];
    const common = fontObj.common as MSDFLayout['common'];
    const chars = fontObj.chars as MSDFLayout['chars'];
    const kerns = fontObj.kernings as MSDFLayout['kernings'];
    const altKerns = fontObj.kerning as MSDFLayout['kernings'];

    return {
      info: info ? info : ({} as MSDFLayout['info']),
      common: common ? common : ({} as MSDFLayout['common']),
      chars: chars ? chars : [],
      kernings: kerns ? kerns : altKerns ? altKerns : [],
      pages,

      distanceField: {
        fieldType: 'msdf',
        distanceRange: fieldRange,
        type: 'msdf',
        range: fieldRange,
      },
    };
  }

  private buildMetadata(
    charset: string | string[],
    fontSize: number,
    textureSize: [number, number],
    atlasCount: number,
    fieldRange: number,
  ) {
    const isArr = Array.isArray(charset);
    const charsetLen = isArr ? (charset as string[]).join('').length : (charset as string).length;

    return {
      charset: charsetLen,
      fontSize,
      textureSize,
      atlasCount,
      fieldRange,
      generatedAt: new Date().toISOString(),
      engine: 'msdf-bmfont-xml',
    };
  }

  async dispose(): Promise<void> {
    // No-op
  }
}

export default MSDFConverter;
