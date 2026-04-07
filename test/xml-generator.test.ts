import { describe, expect, it } from 'vitest';
import type { MSDFLayout } from '../src/types.js';
import XMLGenerator from '../src/xml-generator.js';

describe('XMLGenerator', () => {
  const mockLayout: MSDFLayout = {
    info: {
      face: 'TestFont',
      size: 32,
      bold: 0,
      italic: 0,
      charset: ['A', 'B'],
      unicode: 1,
      stretchH: 100,
      smooth: 1,
      aa: 1,
      padding: [1, 1, 1, 1],
      spacing: [2, 2],
      outline: 0,
    },
    common: {
      lineHeight: 32,
      base: 28,
      scaleW: 512,
      scaleH: 512,
      pages: 1,
      packed: 0,
      alphaChnl: 0,
      redChnl: 0,
      greenChnl: 0,
      blueChnl: 0,
    },
    pages: ['page0.png'],
    distanceField: {
      fieldType: 'msdf',
      distanceRange: 4,
    },
    chars: [
      {
        id: 65,
        index: 0,
        char: 'A',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        xoffset: 0,
        yoffset: 0,
        xadvance: 10,
        page: 0,
        chnl: 15,
      },
    ],
    kernings: [{ first: 65, second: 65, amount: -1 }],
  };

  it('should generate valid XML with all fields', () => {
    const xml = XMLGenerator.generate(mockLayout, 'test-font');
    expect(xml).toContain('<?xml version="1.0"?>');
    expect(xml).toContain('<font>');
    expect(xml).toContain('face="TestFont"');
    expect(xml).toContain('padding="1,1,1,1"');
  });

  it('should handle optional and nullish fields for branch coverage', () => {
    const minimalLayout = {
      ...mockLayout,
      info: {
        ...mockLayout.info,
        charset: null,
        padding: undefined,
        spacing: undefined,
        outline: undefined,
      },
      pages: ['p0.png', 'p1.png'], // Trigger multi-page branch
    } as unknown as MSDFLayout;
    const xml = XMLGenerator.generate(minimalLayout, 'min');
    expect(xml).toContain('charset=""');
    expect(xml).toContain('padding="0,0,0,0"');
    expect(xml).toContain('spacing="0,0"');
    expect(xml).toContain('outline="0"');
    // Pages come directly from layout.pages, not constructed from the font name
    expect(xml).toContain('file="p0.png"');
    expect(xml).toContain('file="p1.png"');
  });

  it('should escape special characters in attributes', () => {
    const layout = {
      ...mockLayout,
      info: { ...mockLayout.info, face: 'Font & "Special"' },
    } as MSDFLayout;
    const xml = XMLGenerator.generate(layout, 'test');
    expect(xml).toContain('face="Font &amp; &quot;Special&quot;"');
  });

  it('uses fontName as face fallback when info.face is empty', () => {
    const layout = {
      ...mockLayout,
      info: { ...mockLayout.info, face: '' },
    } as MSDFLayout;
    const xml = XMLGenerator.generate(layout, 'fallback-name');
    expect(xml).toContain('face="fallback-name"');
  });

  it('should handle null/undefined in escapeAttr', () => {
    // Access private static method for branch coverage
    type EscapeAttrFn = { escapeAttr(v: string | number | null | undefined): string };
    const escapeAttr = (XMLGenerator as unknown as EscapeAttrFn).escapeAttr;
    expect(escapeAttr(null)).toBe('');
    expect(escapeAttr(undefined)).toBe('');
    expect(escapeAttr('<')).toBe('&lt;');
    expect(escapeAttr('>')).toBe('&gt;');
    expect(escapeAttr("'")).toBe('&apos;');
  });
});
