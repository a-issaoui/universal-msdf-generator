import type { MSDFGlyph, MSDFLayout } from './types.js';

/**
 * Generates AngelCode BMFont XML (.fnt) from an MSDFLayout.
 */
export class XMLGenerator {
  /**
   * Escapes a string for safe embedding in an XML attribute value.
   * Handles the five predefined XML entities.
   */
  private static escapeAttr(value: string | number | undefined | null): string {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Generates a standard BMFont XML string from layout data.
   *
   * @param layout   - The MSDF layout returned by MSDFConverter.
   * @param _fontName - Unused. Page filenames are taken directly from {@link MSDFLayout.pages}.
   * @returns AngelCode-compliant XML string.
   */
  public static generate(layout: MSDFLayout, _fontName: string): string {
    const { info, common, chars, kernings, distanceField } = layout;
    const esc = XMLGenerator.escapeAttr;

    const charsetStr = Array.isArray(info.charset) ? info.charset.join(',') : (info.charset ?? '');

    const lines: string[] = [
      '<?xml version="1.0"?>',
      '<font>',
      [
        '  <info',
        `face="${esc(info.face)}"`,
        `size="${esc(info.size)}"`,
        `bold="${esc(info.bold)}"`,
        `italic="${esc(info.italic)}"`,
        `charset="${esc(charsetStr)}"`,
        `unicode="${esc(info.unicode)}"`,
        `stretchH="${esc(info.stretchH)}"`,
        `smooth="${esc(info.smooth)}"`,
        `aa="${esc(info.aa)}"`,
        `padding="${esc((info.padding ?? [0, 0, 0, 0]).join(','))}"`,
        `spacing="${esc((info.spacing ?? [0, 0]).join(','))}"`,
        `outline="${esc(info.outline ?? 0)}"/>`,
      ].join(' '),
      [
        '  <common',
        `lineHeight="${esc(common.lineHeight)}"`,
        `base="${esc(common.base)}"`,
        `scaleW="${esc(common.scaleW)}"`,
        `scaleH="${esc(common.scaleH)}"`,
        `pages="${esc(layout.pages.length)}"`,
        `packed="${esc(common.packed)}"`,
        `alphaChnl="${esc(common.alphaChnl)}"`,
        `redChnl="${esc(common.redChnl)}"`,
        `greenChnl="${esc(common.greenChnl)}"`,
        `blueChnl="${esc(common.blueChnl)}"/>`,
      ].join(' '),
      '  <pages>',
      ...layout.pages.map((pageFile: string, index: number) => {
        return `    <page id="${index}" file="${esc(pageFile)}"/>`;
      }),
      '  </pages>',
      `  <distanceField fieldType="${esc(distanceField.fieldType)}" distanceRange="${esc(distanceField.distanceRange)}"/>`,
      `  <chars count="${esc(chars.length)}">`,
      ...chars.map(
        (char: MSDFGlyph) =>
          `    <char id="${char.id}" x="${char.x}" y="${char.y}" width="${char.width}" height="${char.height}" xoffset="${char.xoffset}" yoffset="${char.yoffset}" xadvance="${char.xadvance}" page="${char.page}" chnl="${char.chnl}"/>`,
      ),
      '  </chars>',
      `  <kernings count="${esc(kernings.length)}">`,
      ...kernings.map(
        (k: { first: number; second: number; amount: number }) =>
          `    <kerning first="${k.first}" second="${k.second}" amount="${k.amount}"/>`,
      ),
      '  </kernings>',
      '</font>',
    ];

    return lines.join('\n');
  }
}

export default XMLGenerator;
