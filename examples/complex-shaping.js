import { UniversalMSDFGenerator } from '../dist/index.js';

/**
 * Complex Script Shaping Example (v1.10.0+)
 *
 * This example demonstrates the powerful HarfBuzz-backed shaping engine.
 * It generates an MSDF font for "Noto Sans Arabic", showcasing:
 * 1. Automatic contextual forms (Initial, Medial, Final, Isolated)
 * 2. Proper RTL ordering
 * 3. Mapping of shaped glyphs to the Private Use Area (PUA)
 */
async function complexShapingExample() {
  const generator = new UniversalMSDFGenerator({
    verbose: true,
    outputDir: './examples/assets/complex',
  });

  try {
    console.log('🚀 Starting Complex Script (Arabic) Example...');

    // When generating for complex scripts like Arabic, Persian, or Hebrew:
    // 1. complexShaping: true - MUST be enabled to use the HarfBuzz engine.
    // 2. charset - Should contain the specific text you intend to render,
    //    as the engine will automatically add the shaped PUA glyphs.

    const arabicText = 'مرحبا بك في مولد MSDF العالمي'; // "Welcome to Universal MSDF Generator"

    console.log(`\n1️⃣  Generating from Google Font (Noto Sans Arabic) for text: "${arabicText}"`);

    const result = await generator.generate('Noto Sans Arabic', {
      charset: arabicText,
      complexShaping: true, // Enable HarfBuzz for contextual forms and RTL
      fontSize: 64,
      textureSize: [1024, 1024],
      outputDir: './examples/assets/complex/arabic',
    });

    if (result.success && result.savedFiles) {
      console.log('✅ Arabic MSDF generation complete!');
      console.log(`   📂 Saved to: ${result.savedFiles.join(', ')}`);

      // The result.metadata.glyphIdMap contains the mapping from raw chars to PUA codes
      console.log('\n📄 Contextual Mapping Summary:');
      console.log(`   Original characters: ${result.metadata.charset}`);
      console.log(
        `   Total glyphs (including shaped forms): ${result.metadata.glyphIdMap ? Object.keys(result.metadata.glyphIdMap).length : 'N/A'}`,
      );
    }

    await generator.dispose();
    console.log('\n🎉 Complex shaping example completed successfully!');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\n❌ Example failed:', message);
    process.exit(1);
  }
}

complexShapingExample();
