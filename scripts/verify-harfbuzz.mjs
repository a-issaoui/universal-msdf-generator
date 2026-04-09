import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import hb from 'harfbuzzjs/hb.js';
import hbjs from 'harfbuzzjs/hbjs.js';

const require = createRequire(import.meta.url);

// Initialize HarfBuzz using the built-in loader
const instance = await hb();
const hbInstance = hbjs(instance);

console.log('HarfBuzz initialized successfully via hb.js loader');

// Verify it works with a font (we found some in node_modules!)
const fontPath = require.resolve('harfbuzzjs/test/fonts/noto/NotoSansArabic-Variable.ttf');
const fontBuf = readFileSync(fontPath);
const blob = hbInstance.createBlob(fontBuf);
const face = hbInstance.createFace(blob, 0);
const font = hbInstance.createFont(face);

console.log('Font loaded:', fontPath);
console.log('UPEM:', face.upem);

font.destroy();
face.destroy();
blob.destroy();

console.log('harfbuzzjs verification OK');
