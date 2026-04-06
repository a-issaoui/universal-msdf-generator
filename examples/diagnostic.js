import { generate } from '../dist/index.js';

async function run() {
  console.log('--- DIAGNOSTIC RUN: ORBITRON ---');
  const result = await generate('Orbitron', {
    fontSize: 256,
    fieldRange: 4,
    verbose: true,
    reuseExisting: false,
    force: true,
  });

  if (result.success) {
    if (result.cached) {
      console.log('✅ Cache HIT (Data omitted to save memory)');
      console.log('Saved files:', result.savedFiles);
    } else {
      console.log('✅ Generation SUCCESS');
      console.log('Characters count:', result.data.chars.length);
      console.log('Info:', JSON.stringify(result.data.info, null, 2));
      console.log('Common:', JSON.stringify(result.data.common, null, 2));
    }
  } else {
    console.error('❌ Generation FAILED:', result.error);
  }
}

run().catch(console.error);
