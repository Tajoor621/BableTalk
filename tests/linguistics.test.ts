import {
  isoFromTag,
  sentenceChunks,
  scriptNotice,
  validatePair,
  languageNotice,
} from '../src/linguistics/languages';
import { acceptLanguage, rankLanguages } from '../src/linguistics/mms';
import labels from '../src/linguistics/mms-labels.json';
jest.mock('onnxruntime-react-native', () => ({}));
jest.mock('../src/models/store', () => ({ verifyMms: jest.fn() }));
it('maps four language tags without conflating Pashto or Hindi', () => {
  expect(isoFromTag('ur-PK')).toBe('urd');
  expect(isoFromTag('ps-AF')).toBe('pus');
  expect(isoFromTag('ar-SA')).toBe('ara');
  expect(isoFromTag('en-GB')).toBe('eng');
  expect(isoFromTag('hi')).toBeUndefined();
});
it('keeps Urdu and Arabic sentence punctuation and bounds long speech chunks', () => {
  const text = 'آپ کیسے ہیں؟ میں ٹھیک ہوں۔ ' + 'word '.repeat(400);
  const chunks = sentenceChunks(text);
  expect(chunks[0]).toBe('آپ کیسے ہیں؟');
  expect(chunks[1]).toBe('میں ٹھیک ہوں۔');
  expect(chunks.every(s => s.length <= 500)).toBe(true);
});
it('flags unexpected script without pretending to identify a dialect', () => {
  expect(scriptNotice('This is entirely Latin text', 'urd')).toContain(
    'mixed-language',
  );
  expect(scriptNotice('آپ کیسے ہیں', 'urd')).toBeNull();
  expect(languageNotice('pus')).toContain('experimental');
  expect(() => validatePair('eng', 'pus')).toThrow();
});
it('rejects short, uncertain or unsupported audio language predictions', () => {
  expect(acceptLanguage([{ code: 'urd', score: 0.99 }], 1)).toBeUndefined();
  expect(
    acceptLanguage(
      [
        { code: 'urd', score: 0.65 },
        { code: 'hin', score: 0.3 },
      ],
      4,
    ),
  ).toBeUndefined();
  expect(acceptLanguage([{ code: 'hin', score: 0.95 }], 5)).toBeUndefined();
  expect(
    acceptLanguage(
      [
        { code: 'urd', score: 0.95 },
        { code: 'hin', score: 0.04 },
      ],
      5,
    ),
  ).toBe('urd');
});
it('uses stable softmax and the actual MMS label mapping', () => {
  const index = Object.entries(labels).find(([, value]) => value === 'urd')![0];
  const logits = new Float32Array(126).fill(-1000);
  logits[Number(index)] = 1000;
  expect(rankLanguages(logits)[0]).toEqual({ code: 'urd', score: 1 });
  expect(() => rankLanguages([NaN])).toThrow();
});
