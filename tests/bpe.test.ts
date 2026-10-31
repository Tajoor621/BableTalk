import fs from 'fs';
import path from 'path';
import { ByteBpe, stripArabicDiacritics } from '../src/linguistics/bpe';
import fixtures from './fixtures/nawah-tokens.json';
it('strips diacritics while preserving Arabic letters and punctuation', () => {
  expect(stripArabicDiacritics('أَنَا أَتَكَلَّمُ العَرَبِيَّةَ')).toBe(
    'أنا أتكلم العربية',
  );
});
it('handles byte-level spaces, repeated merges and token limits', () => {
  const bpe = new ByteBpe({
    vocab: { h: 1, i: 2, hi: 3, Ġ: 4, Ġhi: 5 },
    merges: [
      ['h', 'i'],
      ['Ġ', 'hi'],
    ],
  });
  expect(bpe.encode('hi hi')).toEqual([3, 5]);
  expect(bpe.encode('hi hi', 1)).toEqual([3]);
});
const pack = path.join(process.cwd(), 'generated-assets/nawah/tokenizer.json');
const withPack = fs.existsSync(pack) ? it : it.skip;
withPack(
  'matches reference token IDs for Arabic, diacritics, mixed text and long context',
  () => {
    const tokenizer = new ByteBpe(
      JSON.parse(fs.readFileSync(pack, 'utf8')).model,
    );
    for (const fixture of fixtures) {
      expect(tokenizer.encode(fixture.text)).toEqual(fixture.ids);
    }
  },
);
