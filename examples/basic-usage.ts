import UniversalMSDFGenerator from '../src/index.js';

/**
 * Basic Usage Example
 * This demonstrates the core functionality of the Universal MSDF Generator.
 */
async function basicExample() {
  // 1. Initialize the generator with a custom output directory and verbose logging
  const generator = new UniversalMSDFGenerator({
    verbose: true,
    outputDir: './examples/assets/basic',
  });

  try {
    console.log('🚀 Starting Universal MSDF Generator Examples...');

    // --- Example 1: Google Font ---
    // You can generate MSDF directly from a Google Font name.
    // The fetcher handles CSS parsing and font file retrieval automatically.
    console.log('\n1️⃣  Generating from Google Font (Roboto):');
    const googleResult = await generator.generate('Roboto', {
      weight: '400',
      charset: 'alphanumeric', // Use the built-in alphanumeric preset
      fontSize: 64,
    });

    if (googleResult.success && googleResult.savedFiles) {
      console.log('✅ Google Font generation complete!');
      console.log(`   📂 Saved to: ${googleResult.savedFiles.join(', ')}`);
    }

    // --- Example 2: Remote URL ---
    // You can also use a direct link to any .ttf, .otf, .woff, or .woff2 file.
    console.log('\n2️⃣  Generating from Remote URL:');
    const urlResult = await generator.generate(
      'https://github.com/googlefonts/roboto/raw/main/src/hinted/Roboto-Regular.ttf',
      {
        name: 'Roboto-URL', // Custom name for the output files
        charset: 'ascii', // Use the basic ASCII preset
        outputDir: './examples/assets/url',
      },
    );

    if (urlResult.success && urlResult.savedFiles) {
      console.log('✅ URL generation complete!');
      console.log(`   📂 Saved to: ${urlResult.savedFiles.join(', ')}`);
    }

    // --- Cleanup ---
    // Always dispose of the generator to free up resources (MSDF engine)
    await generator.dispose();

    console.log('\n🎉 All examples completed successfully!');
    console.log('Check the "./examples/assets" directory to see the results.\n');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\n❌ Example failed:', message);
    process.exit(1);
  }
}

basicExample();
