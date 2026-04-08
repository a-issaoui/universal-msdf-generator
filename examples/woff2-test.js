import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * WOFF2 Compression Example
 *
 * This example demonstrates:
 * 1. Fetching a remote WOFF2 font file
 * 2. Automatic decompression using wawoff2
 * 3. Generating MSDF textures and layout
 */
async function run() {
  console.log('--- WOFF2 GENERATION TEST ---');

  // Inter is a great example of a modern WOFF2 font
  const woff2Url = 'https://rsms.me/inter/font-files/Inter-Regular.woff2';
  const outputDir = path.join(__dirname, 'output');

  console.log(`Source: ${woff2Url}`);
  console.log(`Output: ${outputDir}\n`);

  try {
    const result = await generate(woff2Url, {
      fontSize: 42,
      fieldRange: 3,
      outputDir,
      outputFormat: 'all',
      saveFontFile: true,
      verbose: true,
      onProgress: (progress, completed, total) => {
        process.stdout.write(`\rProgress: ${Math.round(progress)}% (${completed}/${total})`);
      },
    });

    console.log('\n');

    if (result.success && !result.cached) {
      console.log('✅ SUCCESS: WOFF2 fetch, decompression, and generation complete.');

      const fontMeta = result.fontMetadata;
      if (fontMeta) {
        console.log('\nDecompression Stats:');
        console.log(
          `- Format: ${fontMeta.originalFormat || 'unknown'} -> ${result.data.info.face ? 'TTF' : 'Uncompressed'}`,
        );
        console.log(`- Compression Ratio: ${fontMeta.compressionRatio?.toFixed(2) || 'N/A'}`);
        console.log(`- Decompression Time: ${fontMeta.decompressionTimeMs?.toFixed(2) || 'N/A'}ms`);
      }

      console.log('\nGenerated Files:');
      result.savedFiles?.forEach((f) => {
        console.log(` - ${path.basename(f)}`);
      });

      console.log('\nLayout Summary:');
      console.log(`- Glyphs: ${result.data.chars.length}`);
      console.log(`- Atlases: ${result.atlases.length}`);
      console.log(`- Size: ${result.data.common.scaleW}x${result.data.common.scaleH}`);
    } else if (result.success && result.cached) {
      console.log('✨ Re-using cached MSDF output.');
      result.savedFiles.forEach((f) => {
        console.log(` - ${path.basename(f)}`);
      });
    } else {
      console.error('❌ FAILED:', result.error);
    }
  } catch (err) {
    console.error('💥 UNEXPECTED ERROR:', err);
  }
}

run().catch(console.error);
