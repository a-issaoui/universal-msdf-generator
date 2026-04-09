import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Msdfgen } from 'msdfgen-wasm';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('msdfgen-wasm/wasm');
const buf = readFileSync(wasmPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gen = await Msdfgen.create(ab);

console.assert(typeof gen._module._loadGlyph === 'function', '_loadGlyph not found');
console.assert(typeof gen._module._getGlyphIndex === 'function', '_getGlyphIndex not found');

console.log('msdfgen-wasm private API verified OK');
