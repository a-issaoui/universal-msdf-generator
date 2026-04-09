import path from 'node:path';
import { UniversalMSDFGenerator } from '../dist/index.js';

async function runDebug() {
  console.log('--- HEBREW DEBUG START ---');
  const generator = new UniversalMSDFGenerator({
    verbose: true,
    complexShaping: true,
  });

  // Use Noto Sans Arabic as it usually has basic RTL support, or any other system font
  const fontPath = path.resolve('test/fixtures/NotoSansArabic.ttf');
  const text = 'שלום'; // Shalom (Hello)

  console.log(`Input Text: ${text}`);

  const result = await generator.generate(fontPath, {
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

    // First char visually should be Final Mem (ם)
    const firstCharCp = shapedText.codePointAt(0);
    if (firstCharCp === 0x05dd) {
      console.log('✨ SUCCESS: Visual order starts with Final Mem (Leftmost for LTR rendering).');
    } else {
      console.log(
        `ℹ️ First char is U+${firstCharCp.toString(16).toUpperCase()}. Note: Mem Final is 05DD.`,
      );
    }
  } else {
    console.error('❌ Generation FAILED:', result.error);
  }
}

runDebug().catch(console.error);
