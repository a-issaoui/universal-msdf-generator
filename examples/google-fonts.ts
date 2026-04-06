import { UniversalMSDFGenerator } from '../src/index.js';

async function googleFontsExample() {
  const generator = new UniversalMSDFGenerator({
    verbose: true,
    outputDir: './examples/assets/google-fonts',
  });

  try {
    // Generate multiple Google Fonts
    const fonts = [
      { name: 'Open Sans', weight: '400' },
      { name: 'Montserrat', weight: '700' },
      { name: 'Lato', weight: '300' },
      { name: 'Roboto Slab', weight: '400' },
    ];

    console.log('Generating multiple Google Fonts...\n');

    for (const font of fonts) {
      console.log(`Generating ${font.name} (${font.weight}):`);

      const result = await generator.generate(font.name, {
        weight: font.weight,
        charset: 'alphanumeric',
        fontSize: 48,
        outputDir: `./examples/assets/google-fonts/${font.name.toLowerCase().replace(/\s+/g, '-')}`,
      });

      console.log(`✅ ${font.name} complete!`);
      // Use savedFiles if the result is successful
      if (result.success && result.savedFiles) {
        console.log(`   Files: ${result.savedFiles.join(', ')}\n`);
      }
    }

    await generator.dispose();

    console.log('\n🎉 Google Fonts examples completed!');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Example failed:', message);
    process.exit(1);
  }
}

googleFontsExample();
