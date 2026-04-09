import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { UniversalMSDFGenerator } from '../src/index.js';
import { analyzeCharset } from '../src/script-detector.js';
import { getHarfBuzz } from '../src/shaper.js';
import type { MSDFSuccess } from '../src/types.js';

describe('Complex Script Support (HarfBuzz)', () => {
  const arabicFontPath = join(__dirname, 'fixtures', 'NotoSansArabic.ttf');

  beforeAll(() => {
    if (!existsSync(arabicFontPath)) {
      throw new Error(`Arabic font fixture missing at ${arabicFontPath}`);
    }
  });

  describe('Script Detector', () => {
    it('should detect Arabic script and RTL direction', () => {
      const analysis = analyzeCharset('السلام عليكم');
      expect(analysis.requiresShaping).toBe(true);
      expect(analysis.primaryScript).toBe('Arab');
      expect(analysis.primaryDirection).toBe('rtl');
    });

    it('should detect Hebrew script and RTL direction', () => {
      const analysis = analyzeCharset('שלום');
      expect(analysis.requiresShaping).toBe(true);
      expect(analysis.primaryScript).toBe('Hebr');
      expect(analysis.primaryDirection).toBe('rtl');
    });

    it('should return LTR for Latin text', () => {
      const analysis = analyzeCharset('Hello World');
      expect(analysis.requiresShaping).toBe(false);
      expect(analysis.primaryDirection).toBe('ltr');
    });
  });

  describe('Shaping & Glyphs', () => {
    it('should generate MSDF for Arabic text with HarfBuzz', async () => {
      const gen = new UniversalMSDFGenerator({
        charset: 'arabic',
        fontSize: 32,
        complexShaping: true, // Explicitly enable
      });

      const result = await gen.generate(arabicFontPath);

      expect(result.success).toBe(true);
      if (result.success && !result.cached) {
        const successResult = result as MSDFSuccess;
        expect(successResult.metadata.shapingEngine).toBe('harfbuzz');
        expect(successResult.metadata.glyphIdMap).toBeDefined();

        // Arabic "Meem" (م) has 4 contextual forms.
        // The 'arabic' preset includes "Meem" (U+0645).
        // HarfBuzz should have produced at least 4 glyphs for it if context samples worked.
        const glyphs = successResult.data.chars;
        expect(glyphs.length).toBeGreaterThan(30); // Preset has ~45 chars, plus contextual forms

        // Verify that we have glyphs in the PUA range (U+E000+)
        const hasPUA = glyphs.some(
          (g: MSDFSuccess['data']['chars'][0]) => g.id >= 0xe000 && g.id <= 0xf8ff,
        );
        expect(hasPUA).toBe(true);
      }
    });

    it('should auto-enable shaping for "arabic" preset', async () => {
      const gen = new UniversalMSDFGenerator({
        charset: 'arabic',
      });

      const result = await gen.generate(arabicFontPath);
      expect(result.success).toBe(true);
      if (result.success && !result.cached) {
        const successResult = result as MSDFSuccess;
        expect(successResult.metadata.shapingEngine).toBe('harfbuzz');
      }
    });

    it('should handle Persian specific characters', async () => {
      const gen = new UniversalMSDFGenerator({
        charset: 'persian',
      });

      const result = await gen.generate(arabicFontPath);
      if (!result.success) console.error('Generation failed:', result.error);
      expect(result.success).toBe(true);
      if (result.success && !result.cached) {
        const successResult = result as MSDFSuccess;
        // Persian 'Pe' (پ) U+067E should be in the BMFont chars
        const hasPeInBMFont = successResult.data.chars.some(
          (g: MSDFSuccess['data']['chars'][0]) => g.id === 0x067e,
        );
        expect(hasPeInBMFont).toBe(true);
      }
    });
    it('should reverse RTL glyph sequence for LTR-centric renderers', async () => {
      const gen = new UniversalMSDFGenerator({
        complexShaping: true,
      });

      const text = 'مرحبا'; // Marhaba (Hello)
      const result = await gen.generate(arabicFontPath, {
        shapingText: text,
        direction: 'rtl',
      });

      console.error(
        `>>>>> TEST RESULT shapedText: "${result.success ? (result as MSDFSuccess).metadata.shapedText : 'FAILED'}" <<<<<`,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const successResult = result as MSDFSuccess;
        const shapedText = successResult.metadata.shapedText || '';

        // Logical first char is Meem (U+0645).
        // Logical last char is Alef (U+0627).
        // Visual first char (in LTR layout) should be Alef (Final).
        expect(shapedText.length).toBe(5);
        expect(shapedText.charCodeAt(0)).toBe(0x0627); // Alef
        expect(shapedText.charCodeAt(4)).toBe(0x0645); // Meem
      }
    });
  });

  describe('HarfBuzz Singleton', () => {
    it('should initialize and provide hbjs instance', async () => {
      const hb = await getHarfBuzz();
      expect(hb).toBeDefined();
      expect(typeof hb.createBlob).toBe('function');
    });
  });
});
