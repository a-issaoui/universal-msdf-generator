import fs from 'node:fs';
import { UniversalMSDFGenerator } from '../dist/index.js';

async function test() {
  const generator = new UniversalMSDFGenerator();
  const fontBuffer = fs.readFileSync('test/fixtures/NotoSansArabic.ttf');

  console.log('--- Debugging Arabic Advances ---');
  const result = await generator.generate(fontBuffer, {
    charset: 'مرحبا',
    complexShaping: true,
  });

  if (result.metadata) {
    console.log(`Shaped Text: ${result.metadata.shapedText}`);

    console.log('\nGlyph Advances in JSON data:');
    const glyphs = result.data.chars;
    for (const char of glyphs) {
      const hexId = char.id.toString(16).toUpperCase();
      console.log(`  Unicode U+${hexId} (BMFont id): advance=${char.xadvance}`);
    }

    // Compare with a standard isolated load
    const standard = await generator.generate(fontBuffer, { charset: 'م', complexShaping: false });
    const isolatedMeem = standard.data.chars.find((c) => c.id === 0x0645);
    console.log(`\nStandard Isolated Meem (U+0645) advance: ${isolatedMeem?.xadvance}`);
  }
}

test().catch(console.error);
