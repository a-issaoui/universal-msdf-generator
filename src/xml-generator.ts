import type { MSDFLayout } from './types.js';

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

  public static *generateStream(layout: MSDFLayout, fontName: string): Generator<string> {
    const { info, common, chars, kernings, distanceField } = layout;
    const esc = XMLGenerator.escapeAttr;

    const faceName = info.face || fontName;
    const charsetStr = Array.isArray(info.charset) ? info.charset.join(',') : (info.charset ?? '');

    yield '<?xml version="1.0"?>';
    yield '<font>';
    yield `  <info face="${esc(faceName)}" size="${esc(info.size)}" bold="${esc(info.bold)}" italic="${esc(info.italic)}" charset="${esc(charsetStr)}" unicode="${esc(info.unicode)}" stretchH="${esc(info.stretchH)}" smooth="${esc(info.smooth)}" aa="${esc(info.aa)}" padding="${esc((info.padding ?? [0, 0, 0, 0]).join(','))}" spacing="${esc((info.spacing ?? [0, 0]).join(','))}" outline="${esc(info.outline ?? 0)}"/>`;
    yield `  <common lineHeight="${esc(common.lineHeight)}" base="${esc(common.base)}" scaleW="${esc(common.scaleW)}" scaleH="${esc(common.scaleH)}" pages="${esc(layout.pages.length)}" packed="${esc(common.packed)}" alphaChnl="${esc(common.alphaChnl)}" redChnl="${esc(common.redChnl)}" greenChnl="${esc(common.greenChnl)}" blueChnl="${esc(common.blueChnl)}"/>`;
    yield '  <pages>';
    for (let index = 0; index < layout.pages.length; index++) {
      yield `    <page id="${index}" file="${esc(layout.pages[index])}"/>`;
    }
    yield '  </pages>';
    yield `  <distanceField fieldType="${esc(distanceField.fieldType)}" distanceRange="${esc(distanceField.distanceRange)}"/>`;
    yield `  <chars count="${esc(chars.length)}">`;
    for (const char of chars) {
      yield `    <char id="${char.id}" x="${char.x}" y="${char.y}" width="${char.width}" height="${char.height}" xoffset="${char.xoffset}" yoffset="${char.yoffset}" xadvance="${char.xadvance}" page="${char.page}" chnl="${char.chnl}"/>`;
    }
    yield '  </chars>';
    yield `  <kernings count="${esc(kernings.length)}">`;
    for (const k of kernings) {
      yield `    <kerning first="${k.first}" second="${k.second}" amount="${k.amount}"/>`;
    }
    yield '  </kernings>';
    yield '</font>';
  }

  public static generate(layout: MSDFLayout, fontName: string): string {
    return [...XMLGenerator.generateStream(layout, fontName)].join('\n');
  }
}

export default XMLGenerator;
