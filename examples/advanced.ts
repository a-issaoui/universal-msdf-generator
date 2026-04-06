import { MSDFUtils, UniversalMSDFGenerator } from '../src/index.js';

async function advancedExample() {
  const generator = new UniversalMSDFGenerator({
    verbose: true,
    outputDir: './examples/assets/advanced',
  });

  try {
    // Example 1: Custom charset
    console.log('1. Generating with custom charset:');
    const customCharset = 'Hello World 123!@#$%^&*()';

    const _result1 = await generator.generateFromGoogle('Inter', {
      charset: customCharset,
      fontSize: 72,
      fieldRange: 8,
      outputDir: './examples/assets/advanced/custom-charset',
    });

    console.log('✅ Custom charset complete!');

    // Example 2: High-quality settings
    console.log('\n2. Generating high-quality MSDF:');
    const _result2 = await generator.generateFromGoogle('Arvo', {
      fontSize: 96,
      textureSize: [2048, 2048],
      fieldRange: 6,
      fixOverlaps: true,
      charset: 'latin',
      outputDir: './examples/assets/advanced/high-quality',
    });

    console.log('✅ High-quality generation complete!');

    // Example 3: Available charset options
    console.log('\n3. Available charset options:');
    const charsets = MSDFUtils.getCharsets();
    console.log('Available charsets:', Object.keys(charsets));

    // Example 4: Texture size calculation
    console.log('\n4. Optimal texture size calculation:');
    const charCount = 95; // ASCII printable
    const fontSize = 64;
    const optimalSize = MSDFUtils.calculateOptimalTextureSize(charCount, fontSize);
    console.log(`For ${charCount} chars at ${fontSize}px: ${optimalSize}px texture`);

    await generator.dispose();

    console.log('\n🎉 Advanced examples completed!');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Example failed:', message);
    process.exit(1);
  }
}

advancedExample();
