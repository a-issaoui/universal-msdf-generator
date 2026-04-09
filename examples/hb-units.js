import fs from 'node:fs';
import hb from 'harfbuzzjs/hb.js';
import hbjs from 'harfbuzzjs/hbjs.js';

async function test() {
  const wasm = await hb();
  const h = hbjs(wasm);
  const fontBuffer = fs.readFileSync('test/fixtures/NotoSansArabic.ttf');
  const blob = h.createBlob(fontBuffer);
  const face = h.createFace(blob, 0);
  const font = h.createFont(face);
  const upem = face.upem;
  console.log(`UPEM: ${upem}`);

  font.setScale(upem, upem);

  const buf = h.createBuffer();
  buf.addText('مرحبا');
  buf.setDirection('rtl');
  buf.setScript('Arab');
  buf.guessSegmentProperties();

  h.shape(font, buf, '');

  const positions = buf.getGlyphPositions();
  console.log('Positions structure (keys):', Object.keys(positions[0] || {}));
  console.log('Positions (JSON):', JSON.stringify(positions[0]));
  for (let i = 0; i < positions.length; i++) {
    console.log(`  Glyph ${i} xAdvance: ${positions[i].xAdvance}`);
  }
}

test().catch(console.error);
