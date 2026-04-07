import { describe, expect, test } from 'vitest';
import {
  detectFontFormat,
  detectFormatFromExtension,
  getFormatErrorMessage,
  isSupportedFormat,
} from '../src/font-format.js';

describe('Font Format Detection', () => {
  const fixtures = {
    ttf: Buffer.from([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0]),
    otf: Buffer.from([0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0]),
    woff2: Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]),
    woff: Buffer.from([0x77, 0x4f, 0x46, 0x46, 0, 0, 0, 0]),
    eot: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0x4c, 0x50, 0x46, 0x00]),
    invalid: Buffer.from([0, 0, 0, 0]),
    short: Buffer.from([0, 0, 0]),
  };

  test('detectFontFormat identifies all signatures', () => {
    expect(detectFontFormat(fixtures.ttf)).toBe('ttf');
    expect(detectFontFormat(fixtures.otf)).toBe('otf');
    expect(detectFontFormat(fixtures.woff2)).toBe('woff2');
    expect(detectFontFormat(fixtures.woff)).toBe('woff');
    expect(detectFontFormat(fixtures.eot)).toBe('eot');
    expect(detectFontFormat(fixtures.invalid)).toBe('unknown');
    expect(detectFontFormat(fixtures.short)).toBe('unknown');
  });

  test('detectFormatFromExtension identifies by extension', () => {
    expect(detectFormatFromExtension('font.ttf')).toBe('ttf');
    expect(detectFormatFromExtension('font.OTF')).toBe('otf');
    expect(detectFormatFromExtension('https://example.com/font.woff2')).toBe('woff2');
    expect(detectFormatFromExtension('font.woff')).toBe('woff');
    expect(detectFormatFromExtension('font.eot')).toBe('eot');
    expect(detectFormatFromExtension('font.txt')).toBe('unknown');
    expect(detectFormatFromExtension('font')).toBe('unknown');
  });

  test('isSupportedFormat filters correctly', () => {
    expect(isSupportedFormat('ttf')).toBe(true);
    expect(isSupportedFormat('otf')).toBe(true);
    expect(isSupportedFormat('woff2')).toBe(true);
    expect(isSupportedFormat('woff')).toBe(false);
    expect(isSupportedFormat('eot')).toBe(false);
    expect(isSupportedFormat('unknown')).toBe(false);
  });

  test('getFormatErrorMessage returns descriptive strings', () => {
    expect(getFormatErrorMessage('ttf')).toContain('TrueType');
    expect(getFormatErrorMessage('woff2')).toContain('will decompress');
    expect(getFormatErrorMessage('woff')).toContain('not supported');
    expect(getFormatErrorMessage('unknown')).toContain('Unknown format');
  });
});
