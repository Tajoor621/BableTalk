import {
  Language,
  languages,
  scriptNotice,
  sentenceChunks,
  Speaker,
  validatePair,
} from '../linguistics/languages';
import { requireLocal, LocalApi, Route } from '../native';
import {
  newId,
  Sessions,
  sessions,
  Session,
  Utterance,
} from '../storage/sessions';
type DialectApi = {
  classify(text: string): Promise<{ label?: string; warning: string }>;
  release(): Promise<void>;
};
/** User-controlled turns. Recording must be stopped before calling translate/replay. */
export class Conversation {
  session?: Session;
  private queue: Promise<unknown> = Promise.resolve();
  private ending = false;
  private playbackGeneration = 0;
  private starting = false;
  private dialectEnabled = false;
  private dialect?: Promise<DialectApi>;
  private contexts: Record<Speaker, { id: string; text: string }[]> = {
    A: [],
    B: [],
  };
  constructor(
    private db: Sessions = sessions,
    private api: () => LocalApi = requireLocal,
    private makeDialect: () => Promise<DialectApi> = async () => {
      const { NawahDialect } = await import('../linguistics/nawah');
      return NawahDialect.create();
    },
  ) {}
  async start(a: Language, b: Language, options: { dialect?: boolean } = {}) {
    if (this.session || this.starting) {
      throw new Error('End the current session first');
    }
    this.starting = true;
    try {
      await this.db.init();
      if (
        languages[a].translation &&
        languages[b].translation &&
        !(await this.api().pairReady(languages[a].tag, languages[b].tag))
      ) {
        throw new Error('Download this translation pair in Models first.');
      }
      await this.api().setSessionActive(true);
      try {
        this.session = await this.db.create(a, b);
        this.ending = false;
        this.dialectEnabled = !!options.dialect;
        this.contexts = { A: [], B: [] };
        return this.session;
      } catch (e) {
        await this.api().setSessionActive(false);
        throw e;
      }
    } finally {
      this.starting = false;
    }
  }
  private async annotate(value: Utterance, source: Language) {
    if (!this.dialectEnabled || source !== 'ara') {
      return;
    }
    const context = this.contexts[value.speaker];
    const existing = context.find(x => x.id === value.id);
    if (existing) {
      existing.text = value.original_text;
    } else {
      context.push({ id: value.id, text: value.original_text });
    }
    if (context.length > 64) {
      context.shift();
    }
    const text = context
      .map(x => x.text)
      .join(' ')
      .split(/\s+/u)
      .slice(-128)
      .join(' ');
    if (text.split(/\s+/u).length < 25) {
      value.warning +=
        ' Arabic dialect: insufficient context (at least 25 words).';
      return;
    }
    try {
      if (!this.dialect) {
        this.dialect = this.makeDialect();
      }
      const result = await (await this.dialect).classify(text);
      value.detected_dialect = result.label || null;
      value.warning = [value.warning, result.warning].filter(Boolean).join(' ');
      if (result.label && this.session) {
        await this.db.setDialect(this.session.id, value.speaker, result.label);
      }
    } catch {
      value.warning +=
        ' Arabic dialect pack is unavailable or failed verification. No label assigned.';
    }
  }
  receive(
    speaker: Speaker,
    text: string,
    detected?: Language,
    warning = '',
  ): Promise<Utterance> {
    if (!this.session || this.ending) {
      return Promise.reject(new Error('No active session'));
    }
    const session = this.session;
    const source = speaker === 'A' ? session.lang_a : session.lang_b;
    const target = speaker === 'A' ? session.lang_b : session.lang_a;
    const value: Utterance = {
      id: newId(),
      session_id: session.id,
      speaker,
      original_text: text.trim(),
      translated_text: '',
      detected_lang: detected || source,
      detected_dialect: null,
      timestamp: Date.now(),
      state: 'pending',
      warning,
      revision: 0,
    };
    const operation = this.queue.then(async () => {
      if (!value.original_text) {
        throw new Error('No speech recognised. Repeat this turn.');
      }
      if (detected && detected !== source) {
        value.warning =
          'Detected language differs from the selected speaker language. Confirm or correct before playback.';
      }
      value.warning = [value.warning, scriptNotice(value.original_text, source)]
        .filter(Boolean)
        .join(' ');
      await this.db.add(value);
      try {
        if (detected && detected !== source) {
          throw new Error(
            'Confirm or correct the source text and language before translating.',
          );
        }
        await this.annotate(value, source);
        validatePair(source, target);
        value.translated_text = await this.api().translate(
          value.original_text,
          languages[source].tag,
          languages[target].tag,
        );
        if (!value.translated_text.trim()) {
          throw new Error('No translation returned. Please rephrase.');
        }
        value.state = 'ready';
      } catch (e) {
        value.state = 'error';
        value.warning = [
          value.warning,
          e instanceof Error ? e.message : String(e),
        ]
          .filter(Boolean)
          .join(' ');
      }
      await this.db.update(value);
      return { ...value };
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  correct(row: Utterance, text: string): Promise<Utterance> {
    if (!this.session || row.session_id !== this.session.id || this.ending) {
      return Promise.reject(
        new Error('Corrections require the active session'),
      );
    }
    const session = this.session;
    const operation = this.queue.then(async () => {
      const source = row.speaker === 'A' ? session.lang_a : session.lang_b;
      const target = row.speaker === 'A' ? session.lang_b : session.lang_a;
      validatePair(source, target);
      const corrected = text.trim();
      if (!corrected) {
        throw new Error('Enter the words actually spoken');
      }
      const value = {
        ...row,
        original_text: corrected,
        detected_lang: source,
        detected_dialect: null,
        translated_text: '',
        revision: row.revision + 1,
        state: 'pending' as Utterance['state'],
        warning: 'Edited by user. Translation regenerated.',
      };
      await this.db.update(value);
      try {
        value.translated_text = await this.api().translate(
          corrected,
          languages[source].tag,
          languages[target].tag,
        );
        if (!value.translated_text.trim()) {
          throw new Error('No translation returned');
        }
        value.state = 'ready';
      } catch (e) {
        value.state = 'error';
        value.warning = String(e);
      }
      await this.db.update(value);
      await this.annotate(value, source);
      await this.db.update(value);
      return value;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  async replay(row: Utterance, routeForA: Route) {
    if (
      !this.session ||
      row.session_id !== this.session.id ||
      row.state !== 'ready' ||
      !row.translated_text ||
      this.ending
    ) {
      throw new Error('No playable translation');
    }
    const target =
      row.speaker === 'A' ? this.session.lang_b : this.session.lang_a;
    const route = row.speaker === 'A' ? 'speaker' : routeForA;
    const generation = ++this.playbackGeneration;
    await this.api().initSpeech();
    for (const sentence of sentenceChunks(row.translated_text)) {
      if (generation !== this.playbackGeneration) {
        break;
      }
      await this.api().speak(sentence, languages[target].tag, route);
    }
  }
  async stopPlayback() {
    this.playbackGeneration++;
    await this.api().stopSpeech();
  }
  async end() {
    if (!this.session) {
      return;
    }
    this.ending = true;
    try {
      await this.stopPlayback();
      await this.queue;
      await this.db.end(this.session.id);
      this.session = undefined;
      await this.dialect?.then(model => model.release()).catch(() => {});
      this.dialect = undefined;
    } finally {
      await this.api().setSessionActive(false);
    }
  }
}
