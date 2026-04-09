import fs from 'node:fs';
import { UniversalMSDFGenerator } from '../dist/index.js';

async function test() {
  const generator = new UniversalMSDFGenerator();
  const fontBuffer = fs.readFileSync('test/fixtures/NotoSansArabic.ttf');

  console.log('--- Testing Arabic Mapping Robustness ---');
  const result = await generator.generate(fontBuffer, {
    charset: 'مرحبا',
    complexShaping: true,
  });

  if (result.metadata) {
    console.log(`Shaping Engine: ${result.metadata.shapingEngine}`);
    console.log(`Shaped Text: ${result.metadata.shapedText}`);
    const codes = [...result.metadata.shapedText].map(
      (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    );
    console.log(`Codepoints: ${codes.join(' ')}`);

    const hasPUA = codes.some((c) => c.startsWith('U+E'));
    console.log(`Has PUA: ${hasPUA}`);

    console.log('\nGlyph ID Map:');
    for (const [id, unicode] of Object.entries(result.metadata.glyphIdMap)) {
      console.log(`  ID ${id} -> U+${unicode.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  } else {
    console.log('No metadata returned!');
  }
}

test().catch(console.error);
