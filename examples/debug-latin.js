import path from 'node:path';
import { UniversalMSDFGenerator } from '../dist/index.js';

async function runDebug() {
  console.log('--- LATIN DEBUG START ---');
  const generator = new UniversalMSDFGenerator({
    verbose: true,
    complexShaping: false, // Normal shaping for Latin
  });

  const fontPath = path.resolve('test/fixtures/NotoSansArabic.ttf'); // Usually contains basic Latin
  const text = 'Hello';

  console.log(`Input Text: ${text}`);

  const result = await generator.generate(fontPath, {
    charset: text,
  });

  if (result.success) {
    console.log('✅ Generation SUCCESS');
    console.log(`🔗 Logical Text  : ${text}`);
  } else {
    console.error('❌ Generation FAILED:', result.error);
  }
}

runDebug().catch(console.error);
