declare module 'msdf-bmfont-xml' {
  /**
   * Configuration options for msdf-bmfont-xml.
   * Note: the font buffer/path is passed as the first argument to generateBMFont,
   * NOT as a field of this config object.
   */
  export interface MSDFConfig {
    outputType?: 'json' | 'xml' | 'fnt';
    filename?: string;
    fontName?: string;
    fontSize?: number;
    charset?: string | string[];
    textureSize?: [number, number];
    distanceRange?: number;
    fieldType?: 'msdf' | 'sdf' | 'psdf';
    reuse?: boolean;
    fixOverlaps?: boolean;
    pot?: boolean;
    square?: boolean;
    rot?: boolean;
    rtl?: boolean;
    'smart-size'?: boolean;
    rgba?: boolean;
    'texture-padding'?: number;
  }

  /**
   * @param font     - Font file path or raw Buffer. Passed as the first positional
   *                   argument — do NOT also set it in the config object.
   * @param config   - Generation options.
   * @param callback - Called with (error, textures, fontDescriptor) when done.
   */
  function generateBMFont(
    font: string | Buffer,
    config: MSDFConfig,
    callback: (
      error: Error | null,
      textures: Array<{ filename: string; texture: Buffer }>,
      font: unknown,
    ) => void,
  ): void;

  export default generateBMFont;
}
