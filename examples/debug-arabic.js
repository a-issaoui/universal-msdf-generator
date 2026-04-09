import path from 'node:path';
import { UniversalMSDFGenerator } from '../dist/index.js';

async function runDebug() {
  console.log('--- ARABIC DEBUG START ---');
  const generator = new UniversalMSDFGenerator({
    verbose: true,
    complexShaping: true,
  });

  const arabicFontPath = path.resolve('test/fixtures/NotoSansArabic.ttf');
  const text = 'مرحبا'; // Marhaba (Hello)

  console.log(`Input Text: ${text}`);
  console.log(`Shaping against font: ${arabicFontPath}`);

  const result = await generator.generate(arabicFontPath, {
    shapingText: text,
    direction: 'rtl',
  });

  if (result.success) {
    const { shapedText } = result.metadata;
    console.log('✅ Generation SUCCESS');
    console.log(`🔗 Logical Text  : ${text}`);
    console.log(`🔗 Visual Text   : ${shapedText}`);

    console.log('--- Sequence Verification ---');
    for (let i = 0; i < shapedText.length; i++) {
      const cp = shapedText.codePointAt(i);
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      console.log(`Index ${i}: U+${hex}`);
    }

    // Verify if first char is visual start (Alef for RTL)
    const firstCharCp = shapedText.codePointAt(0);
    if (firstCharCp === 0x0627) {
      console.log('✨ SUCCESS: Visual order starts with Alef (Leftmost for LTR rendering).');
    } else {
      console.error(
        `❌ FAILURE: Visual order starts with U+${firstCharCp.toString(16).toUpperCase()}`,
      );
    }
  } else {
    console.error('❌ Generation FAILED:', result.error);
  }
}

runDebug().catch(console.error);
