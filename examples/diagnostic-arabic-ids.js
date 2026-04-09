import fs from 'node:fs';
import { getHarfBuzz } from '../src/shaper.js';

async function test() {
  const fontBuffer = fs.readFileSync('test/fixtures/NotoSansArabic.ttf');
  const hb = await getHarfBuzz();
  const blob = hb.createBlob(fontBuffer);
  const face = hb.createFace(blob, 0);
  const font = hb.createFont(face);
  font.setScale(face.upem, face.upem);

  const test = (text) => {
    const buf = hb.createBuffer();
    buf.addText(text);
    buf.setDirection('rtl');
    buf.setScript('Arab');
    buf.setLanguage('ar');
    buf.guessSegmentProperties();
    hb.shape(font, buf, '');
    const res = buf.getGlyphInfos().map((i) => i.codepoint);
    buf.destroy();
    return res;
  };

  const isolatedMeem = test('م')[0];
  const isolatedReh = test('ر')[0];

  const word = test('مر');
  const shapedReh = word[0];
  const shapedMeem = word[1];

  console.log(`Isolated Meem ID: ${isolatedMeem}`);
  console.log(`Shaped Meem ID (in "مر"): ${shapedMeem}`);
  console.log(`Is same? ${isolatedMeem === shapedMeem}`);

  console.log(`Isolated Reh ID: ${isolatedReh}`);
  console.log(`Shaped Reh ID (in "مر"): ${shapedReh}`);
  console.log(`Is same? ${isolatedReh === shapedReh}`);

  font.destroy();
  face.destroy();
}

test().catch(console.error);
