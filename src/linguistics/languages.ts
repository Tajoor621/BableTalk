export const languages = {
  eng: {
    name: 'English',
    native: 'English',
    tag: 'en',
    rtl: false,
    translation: true,
  },
  urd: {
    name: 'Urdu',
    native: 'اردو',
    tag: 'ur',
    rtl: true,
    translation: true,
  },
  ara: {
    name: 'Arabic',
    native: 'العربية',
    tag: 'ar',
    rtl: true,
    translation: true,
  },
  cmn: {
    name: 'Chinese (Mandarin speech)',
    native: '中文',
    tag: 'zh',
    rtl: false,
    translation: true,
  },
  pus: {
    name: 'Pashto',
    native: 'پښتو',
    tag: 'ps',
    rtl: true,
    translation: false,
  },
} as const;
export type Language = keyof typeof languages;
export type Speaker = 'A' | 'B';
export function isLanguage(code: string): code is Language {
  return Object.prototype.hasOwnProperty.call(languages, code);
}
export function isoFromTag(tag: string): Language | undefined {
  const value = tag.toLowerCase().split('-')[0];
  return (Object.keys(languages) as Language[]).find(
    code => languages[code].tag === value || code === value,
  );
}
export function languageNotice(lang: Language) {
  return lang === 'pus'
    ? 'Pashto is experimental transcription only. Translation and speech playback are unavailable.'
    : lang === 'ara'
    ? 'Dialect recognition needs sufficient Arabic text. Dialect labels do not certify translation quality.'
    : lang === 'cmn'
    ? 'Chinese speech recognition is intended for Mandarin. Check regional speech and handwritten characters before translating.'
    : lang === 'urd'
    ? 'Urdu language identification only. Hindi and Punjabi are distinct languages; confirm short or mixed turns.'
    : '';
}
export function validatePair(a: Language, b: Language) {
  if (!languages[a].translation || !languages[b].translation) {
    throw new Error(
      'This pair supports transcription only. Pashto translation is not installed.',
    );
  }
}
/** Conservative display check, not a linguistic classifier. Do not reject names or mixed speech. */
export function scriptNotice(text: string, lang: Language): string | null {
  const letters = text.match(/\p{L}/gu) || [];
  const arabic = text.match(/\p{Script=Arabic}/gu) || [];
  const han = text.match(/\p{Script=Han}/gu) || [];
  const unexpected = lang === 'cmn'
    ? han.length / letters.length < 0.3
    : lang === 'eng'
    ? (arabic.length + han.length) / letters.length > 0.3
    : arabic.length / letters.length < 0.3;
  if (letters.length >= 6 && unexpected) {
    return 'Check the recognised script and language; this may be a mixed-language turn.';
  }
  return null;
}
export function sentenceChunks(text: string, limit = 500): string[] {
  const result: string[] = [];
  const sentences = text.match(/[^.?!。！？؟۔\n]+[.?!。！？؟۔\n]*/gu) || [];
  for (const sentence of sentences) {
    let rest = sentence.trim();
    while (rest.length > limit) {
      const space = rest.lastIndexOf(' ', limit);
      const end = space > limit / 2 ? space : limit;
      result.push(rest.slice(0, end));
      rest = rest.slice(end).trim();
    }
    if (rest) {
      result.push(rest);
    }
  }
  return result;
}
