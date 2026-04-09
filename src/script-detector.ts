/**
 * script-detector.ts
 *
 * Analyzes a charset string and determines whether it contains complex-script
 * characters that require HarfBuzz shaping.
 */

const COMPLEX_SCRIPT_RANGES: Array<{
  start: number;
  end: number;
  script: string;
  direction: 'rtl' | 'ltr';
}> = [
  { start: 0x0600, end: 0x06ff, script: 'Arab', direction: 'rtl' }, // Arabic
  { start: 0x0750, end: 0x077f, script: 'Arab', direction: 'rtl' }, // Arabic Supplement
  { start: 0x08a0, end: 0x08ff, script: 'Arab', direction: 'rtl' }, // Arabic Extended-A
  { start: 0xfb50, end: 0xfdff, script: 'Arab', direction: 'rtl' }, // Arabic Presentation Forms-A
  { start: 0xfe70, end: 0xfeff, script: 'Arab', direction: 'rtl' }, // Arabic Presentation Forms-B
  { start: 0x0590, end: 0x05ff, script: 'Hebr', direction: 'rtl' }, // Hebrew
  { start: 0xfb1d, end: 0xfb4f, script: 'Hebr', direction: 'rtl' }, // Hebrew Presentation Forms
  { start: 0x0700, end: 0x074f, script: 'Syrc', direction: 'rtl' }, // Syriac
  { start: 0x0900, end: 0x097f, script: 'Deva', direction: 'ltr' }, // Devanagari
  { start: 0x0980, end: 0x09ff, script: 'Beng', direction: 'ltr' }, // Bengali
  { start: 0x0e00, end: 0x0e7f, script: 'Thai', direction: 'ltr' }, // Thai
];

export interface ScriptAnalysis {
  requiresShaping: boolean;
  primaryScript: string | null;
  primaryDirection: 'rtl' | 'ltr';
  hasRtl: boolean;
  hasLtr: boolean;
  scriptCoverage: Map<string, number>; // script → character count
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: intentional — comprehensive heuristic analysis
export function analyzeCharset(charset: string): ScriptAnalysis {
  const coverage = new Map<string, number>();

  for (const char of charset) {
    /* v8 ignore next */
    const cp = char.codePointAt(0) ?? 0;
    for (const range of COMPLEX_SCRIPT_RANGES) {
      if (cp >= range.start && cp <= range.end) {
        /* v8 ignore next */
        coverage.set(range.script, (coverage.get(range.script) ?? 0) + 1);
        break;
      }
    }
  }

  const rtlScripts = new Set(['Arab', 'Hebr', 'Syrc', 'Thaa', 'Cprt']);
  let hasRtl = false;
  let hasLtr = false;

  if (coverage.size === 0) {
    return {
      requiresShaping: false,
      primaryScript: null,
      primaryDirection: 'ltr',
      hasRtl: false,
      hasLtr: false,
      scriptCoverage: coverage,
    };
  }

  let primaryScript: string | null = null;
  let maxCount = 0;
  for (const [script, count] of coverage) {
    if (rtlScripts.has(script)) {
      hasRtl = true;
    } else {
      hasLtr = true;
    }

    if (count > maxCount) {
      maxCount = count;
      primaryScript = script;
    }
  }

  /* v8 ignore next */
  const primaryDirection = hasRtl ? 'rtl' : 'ltr';

  return {
    requiresShaping: true,
    primaryScript: primaryScript || (hasRtl ? 'Arab' : 'Latn'),
    primaryDirection,
    hasRtl,
    hasLtr,
    scriptCoverage: coverage,
  };
}

export function isComplexScriptCodepoint(cp: number): boolean {
  return COMPLEX_SCRIPT_RANGES.some((r) => cp >= r.start && cp <= r.end);
}

export function autoDetectComplexScript(charset: string): boolean {
  return analyzeCharset(charset).requiresShaping;
}
