/**
 * presentation-forms.ts
 *
 * Fallback strategy: expand base Arabic codepoints to Presentation Forms.
 * Only useful for legacy Arabic fonts with Presentation Forms in their cmap.
 * Modern fonts (Noto, Vazirmatn, Amiri) require HarfBuzz shaping instead.
 */

export const ARABIC_PRESENTATION_MAP = new Map<
  number,
  {
    isolated?: number;
    initial?: number;
    medial?: number;
    final?: number;
  }
>([
  [0x0628, { isolated: 0xfe8f, initial: 0xfe91, medial: 0xfe92, final: 0xfe90 }], // ب
  [0x062a, { isolated: 0xfe95, initial: 0xfe97, medial: 0xfe98, final: 0xfe96 }], // ت
  [0x062b, { isolated: 0xfe99, initial: 0xfe9b, medial: 0xfe9c, final: 0xfe9a }], // ث
  [0x062c, { isolated: 0xfe9d, initial: 0xfe9f, medial: 0xfea0, final: 0xfe9e }], // ج
  [0x062d, { isolated: 0xfea1, initial: 0xfea3, medial: 0xfea4, final: 0xfea2 }], // ح
  [0x062e, { isolated: 0xfea5, initial: 0xfea7, medial: 0xfea8, final: 0xfea6 }], // خ
  [0x062f, { isolated: 0xfea9, final: 0xfeaa }], // د (right-joining: no init/medi)
  [0x0630, { isolated: 0xfeab, final: 0xfeac }], // ذ
  [0x0631, { isolated: 0xfead, final: 0xfeae }], // ر
  [0x0632, { isolated: 0xfeaf, final: 0xfeb0 }], // ز
  [0x0633, { isolated: 0xfeb1, initial: 0xfeb3, medial: 0xfeb4, final: 0xfeb2 }], // س
  [0x0634, { isolated: 0xfeb5, initial: 0xfeb7, medial: 0xfeb8, final: 0xfeb6 }], // ش
  [0x0635, { isolated: 0xfeb9, initial: 0xfebb, medial: 0xfebc, final: 0xfeba }], // ص
  [0x0636, { isolated: 0xfebd, initial: 0xfebf, medial: 0xfec0, final: 0xfebe }], // ض
  [0x0637, { isolated: 0xfec1, initial: 0xfec3, medial: 0xfec4, final: 0xfec2 }], // ط
  [0x0638, { isolated: 0xfec5, initial: 0xfec7, medial: 0xfec8, final: 0xfec6 }], // ظ
  [0x0639, { isolated: 0xfec9, initial: 0xfecb, medial: 0xfecc, final: 0xfeca }], // ع
  [0x063a, { isolated: 0xfecd, initial: 0xfecf, medial: 0xfed0, final: 0xfece }], // غ
  [0x0641, { isolated: 0xfed1, initial: 0xfed3, medial: 0xfed4, final: 0xfed2 }], // ف
  [0x0642, { isolated: 0xfed5, initial: 0xfed7, medial: 0xfed8, final: 0xfed6 }], // ق
  [0x0643, { isolated: 0xfed9, initial: 0xfedb, medial: 0xfedc, final: 0xfeda }], // ك
  [0x0644, { isolated: 0xfedd, initial: 0xfedf, medial: 0xfee0, final: 0xfede }], // ل
  [0x0645, { isolated: 0xfee1, initial: 0xfee3, medial: 0xfee4, final: 0xfee2 }], // م
  [0x0646, { isolated: 0xfee5, initial: 0xfee7, medial: 0xfee8, final: 0xfee6 }], // ن
  [0x0647, { isolated: 0xfee9, initial: 0xfeeb, medial: 0xfeec, final: 0xfeea }], // ه
  [0x0648, { isolated: 0xfeed, final: 0xfeee }], // و (right-joining)
  [0x064a, { isolated: 0xfef1, initial: 0xfef3, medial: 0xfef4, final: 0xfef2 }], // ي

  // Bug #6: Missing common Arabic letters
  [0x0621, { isolated: 0xfe80 }], // ء Hamza (non-joining)
  [0x0622, { isolated: 0xfe81, final: 0xfe82 }], // آ Alef with Madda (right-joining)
  [0x0623, { isolated: 0xfe83, final: 0xfe84 }], // أ Alef with Hamza Above (right-joining)
  [0x0624, { isolated: 0xfe85, final: 0xfe86 }], // ؤ Waw with Hamza (right-joining)
  [0x0625, { isolated: 0xfe87, final: 0xfe88 }], // إ Alef with Hamza Below (right-joining)
  [0x0626, { isolated: 0xfe89, initial: 0xfe8b, medial: 0xfe8c, final: 0xfe8a }], // ئ Yeh with Hamza (dual-joining)
  [0x0627, { isolated: 0xfe8d, final: 0xfe8e }], // ا Alef (right-joining)
  [0x0629, { isolated: 0xfe93, final: 0xfe94 }], // ة Teh Marbuta (right-joining)
  [0x0649, { isolated: 0xfeef, final: 0xfef0 }], // ى Alef Maqsura (right-joining)
]);

// Lam-Alef mandatory ligatures (most common first)
export const LAM_ALEF_PRESENTATION: number[] = [
  0xfefb,
  0xfefc, // Lam + Alef (most common: isolated, final)
  0xfef5,
  0xfef6, // Lam + Alef with Madda Above
  0xfef7,
  0xfef8, // Lam + Alef with Hamza Above
  0xfef9,
  0xfefa, // Lam + Alef with Hamza Below
];

export function resolvePresentationForms(charset: string): number[] {
  const result = new Set<number>();

  for (const char of charset) {
    /* v8 ignore next */
    const cp = char.codePointAt(0) ?? 0;
    const forms = ARABIC_PRESENTATION_MAP.get(cp);
    if (forms) {
      result.add(cp); // base (isolated via cmap)
      for (const v of Object.values(forms)) if (v !== undefined) result.add(v);
    } else {
      result.add(cp);
    }
  }

  if (charset.includes('\u0644')) {
    // Lam present
    for (const lc of LAM_ALEF_PRESENTATION) result.add(lc);
  }

  return Array.from(result);
}
