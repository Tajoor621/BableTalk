import { Buffer } from 'buffer';
export type BpeModel = {
  vocab: Record<string, number>;
  merges: (string | string[])[];
};
export function stripArabicDiacritics(text: string) {
  return text.replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/gu, '');
}
function byteAlphabet() {
  const bytes = [
    ...Array.from({ length: 94 }, (_, i) => i + 33),
    ...Array.from({ length: 12 }, (_, i) => i + 161),
    ...Array.from({ length: 82 }, (_, i) => i + 174),
  ];
  const points = [...bytes];
  let extra = 0;
  for (let b = 0; b < 256; b++) {
    if (!bytes.includes(b)) {
      bytes.push(b);
      points.push(256 + extra++);
    }
  }
  return new Map(
    bytes.map((byte, i) => [byte, String.fromCodePoint(points[i])]),
  );
}
/** Exact byte-level BPE vocabulary/merge ranks from the verified Nawah tokenizer. */
export class ByteBpe {
  private alphabet = byteAlphabet();
  private ranks = new Map<string, number>();
  private cache = new Map<string, number[]>();
  constructor(private model: BpeModel) {
    model.merges.forEach((pair, i) =>
      this.ranks.set(
        (typeof pair === 'string' ? pair.split(' ') : pair).join('\0'),
        i,
      ),
    );
  }
  encode(text: string, limit = 192): number[] {
    const parts =
      stripArabicDiacritics(text).match(
        /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu,
      ) || [];
    const ids: number[] = [];
    for (const part of parts) {
      let tokens = this.cache.get(part);
      if (!tokens) {
        const pieces = Array.from(
          Buffer.from(part, 'utf8'),
          b => this.alphabet.get(b)!,
        );
        while (pieces.length > 1) {
          let index = -1;
          let rank = Infinity;
          for (let i = 0; i < pieces.length - 1; i++) {
            const score = this.ranks.get(`${pieces[i]}\0${pieces[i + 1]}`);
            if (score !== undefined && score < rank) {
              rank = score;
              index = i;
            }
          }
          if (index < 0) {
            break;
          }
          pieces.splice(index, 2, pieces[index] + pieces[index + 1]);
        }
        tokens = pieces.map(piece => {
          const id = this.model.vocab[piece];
          if (id === undefined) {
            throw new Error('Tokenizer vocabulary mismatch');
          }
          return id;
        });
        if (this.cache.size >= 512) {
          this.cache.clear();
        }
        this.cache.set(part, tokens);
      }
      ids.push(...tokens);
      if (ids.length >= limit) {
        break;
      }
    }
    return ids.slice(0, limit);
  }
}
