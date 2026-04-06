import { MSDFUtils, UniversalMSDFGenerator } from '../dist/index.js';

async function advancedExample() {
  const generator = new UniversalMSDFGenerator({
    verbose: true,
    outputDir: './examples/assets/advanced',
  });

  try {
    // Example 1: Custom charset
    console.log('1. Generating with custom charset:');
    await generator.generate('Inter', {
      charset: 'Hello World 123!@#$%^&*()',
      fontSize: 72,
      fieldRange: 8,
      outputDir: './examples/assets/advanced/custom-charset',
    });
    console.log('✅ Custom charset complete!');

    // Example 2: High-quality settings with inktrap edge coloring
    // Use edgeColoring: 'inktrap' for decorative/display fonts — reduces MSDF artifacts
    // Use fieldRange: 6–8 when you need glow, outline, or drop-shadow shader effects
    console.log('\n2. Generating high-quality MSDF (inktrap edge coloring):');
    await generator.generate('Arvo', {
      fontSize: 96,
      textureSize: [2048, 2048],
      fieldRange: 6,
      edgeColoring: 'inktrap', // better for complex/decorative glyphs
      padding: 4, // extra padding for mipmapping
      fixOverlaps: true, // pre-process overlapping contours
      charset: 'latin',
      outputDir: './examples/assets/advanced/high-quality',
    });
    console.log('✅ High-quality generation complete!');

    // Example 3: Available charset options
    console.log('\n3. Available charset options:');
    const charsets = MSDFUtils.getCharsets();
    console.log('Available charsets:', Object.keys(charsets));

    // Example 4: Texture size calculation (deprecated helper, for reference only)
    console.log('\n4. Optimal texture size calculation:');
    const charCount = 95; // ASCII printable
    const fontSize = 64;
    const optimalSize = MSDFUtils.calculateOptimalTextureSize(charCount, fontSize);
    console.log(`For ${charCount} chars at ${fontSize}px: ${optimalSize}px texture`);

    await generator.dispose();
    console.log('\n🎉 Advanced examples completed!');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Example failed:', message);
    process.exit(1);
  }
}

advancedExample();
