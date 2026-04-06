import { describe, expect, it } from 'vitest';
import XMLGenerator from '../src/xml-generator.js';

describe('XMLGenerator', () => {
  const mockLayout: any = {
    info: {
      face: 'Roboto',
      size: 48,
      bold: 0,
      italic: 0,
      charset: ['a'],
      unicode: 1,
      stretchH: 100,
      smooth: 1,
      aa: 1,
      padding: [0, 0, 0, 0],
      spacing: [0, 0],
      outline: 0,
    },
    common: {
      lineHeight: 50,
      base: 40,
      scaleW: 512,
      scaleH: 512,
      packed: 0,
      alphaChnl: 0,
      redChnl: 0,
      greenChnl: 0,
      blueChnl: 0,
    },
    pages: ['font.png'],
    chars: [
      {
        id: 97,
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
    kernings: [{ first: 97, second: 97, amount: -1 }],
    distanceField: { fieldType: 'msdf', distanceRange: 4 },
  };

  it('should generate valid AngelCode XML', () => {
    const xml = XMLGenerator.generate(mockLayout, 'font');
    expect(xml).toContain('<?xml version="1.0"?>');
    expect(xml).toContain('<font>');
    expect(xml).toContain('<info face="Roboto"');
    expect(xml).toContain('<char id="97"');
    expect(xml).toContain('<kerning first="97"');
  });

  it('should escape special characters in attributes', () => {
    const layout = {
      ...mockLayout,
      info: { ...mockLayout.info, face: 'Font & "Quotes"' },
    };
    const xml = XMLGenerator.generate(layout, 'font');
    expect(xml).toContain('face="Font &amp; &quot;Quotes&quot;"');
  });

  it('should handle multi-page layouts', () => {
    const multiPageLayout = {
      ...mockLayout,
      pages: ['p1.png', 'p2.png'],
    };
    const xml = XMLGenerator.generate(multiPageLayout, 'font');
    expect(xml).toContain('file="font-0.png"');
    expect(xml).toContain('file="font-1.png"');
  });

  it('should handle null/undefined attribute values gracefully', () => {
    const layout = {
      ...mockLayout,
      info: { ...mockLayout.info, face: null as any },
    };
    const xml = XMLGenerator.generate(layout, 'font');
    expect(xml).toContain('face=""');
  });
});
