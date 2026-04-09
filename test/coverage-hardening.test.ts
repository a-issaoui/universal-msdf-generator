import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UniversalMSDFGenerator } from '../src/index.js';
import { resolvePresentationForms } from '../src/presentation-forms.js';
import { clearShaperCache, getRequiredGlyphIds, SCRIPT_DEFAULT_LANGUAGE } from '../src/shaper.js';
import MSDFUtils from '../src/utils.js';

describe('Coverage Hardening (100% Target)', () => {
  const arabicFontPath = join(__dirname, 'fixtures', 'NotoSansArabic.ttf');
  const fontBuffer = readFileSync(arabicFontPath);

  it('should cover shaper cache cleanup branches', async () => {
    clearShaperCache();
    await getRequiredGlyphIds('A', fontBuffer, {
      direction: 'ltr',
      script: 'Latn',
      language: 'en',
    });
    clearShaperCache();
  });

  it('should cover ligature collection and continue branches in shaper', async () => {
    // 1. Valid ligature (Proceed path)
    await getRequiredGlyphIds('\u0644\u0627', fontBuffer, {
      direction: 'rtl',
      script: 'Arab',
      language: 'ar',
    });

    // 2. Not a ligature (Continue path)
    await getRequiredGlyphIds('\u0644\u0627', fontBuffer, {
      direction: 'ltr',
      script: 'Latn',
      language: 'en',
    });

    // 3. Partial charset (Branch 1 continue)
    await getRequiredGlyphIds('\u0644', fontBuffer, {
      direction: 'rtl',
      script: 'Arab',
      language: 'ar',
    });
  });

  it('should cover presentation forms branches', () => {
    resolvePresentationForms('A');
    resolvePresentationForms('\u0644');
    expect(resolvePresentationForms('')).toEqual([]);
  });

  it('should cover all charset presets in utils', () => {
    ['ascii', 'alphanumeric', 'latin', 'cyrillic', 'arabic', 'persian', 'urdu', 'hebrew'].forEach(
      (name) => {
        MSDFUtils.resolveCharset(name);
      },
    );
    expect(() => MSDFUtils.resolveCharset('custom')).toThrow();
  });

  it('should cover script language defaults missed branches', () => {
    ['Syrc', 'Deva', 'Beng', 'Thai', 'Grek', 'Cyrl'].forEach((s) => {
      expect(SCRIPT_DEFAULT_LANGUAGE[s]).toBeDefined();
    });
  });

  it('should cover converter options branches', async () => {
    const gen = new UniversalMSDFGenerator();
    // 1. fixOverlaps: true (explicit)
    await gen.generate(arabicFontPath, { fixOverlaps: true });
    // 2. fixOverlaps: false (explicit)
    await gen.generate(arabicFontPath, { fixOverlaps: false, complexShaping: true });
    // 3. fixOverlaps: undefined (implicit default)
    await gen.generate(arabicFontPath, { fixOverlaps: undefined });
  });

  it('should verify shapedText restoration in metadata', async () => {
    const gen = new UniversalMSDFGenerator();
    const result = await gen.generate(arabicFontPath, {
      charset: '\u0645\u0631\u062d\u0628\u0627', // "مرحبا"
      complexShaping: true,
    });

    if (!result.success) {
      console.error('Generation failed:', result.error);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.metadata.shapedText).toBeDefined();
      // "مرحبا" shaped should contain PUA characters for medial/final forms
      expect(result.metadata.shapedText).not.toBe('\u0645\u0631\u062d\u0628\u0627');

      const shapedText = result.metadata.shapedText ?? '';
      const hasPUA = [...shapedText].some((c) => {
        const cp = c.codePointAt(0) ?? 0;
        return cp >= 0xe000 && cp <= 0xf8ff;
      });
      expect(hasPUA).toBe(true);
    }
  });
});
