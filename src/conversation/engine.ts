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
/** User-controlled turns. Recording must be stopped before calling translate/replay. */
export class Conversation {
  session?: Session;
  private queue: Promise<unknown> = Promise.resolve();
  private ending = false;
  private playbackGeneration = 0;
  constructor(
    private db: Sessions = sessions,
    private api: () => LocalApi = requireLocal,
  ) {}
  async start(a: Language, b: Language) {
    if (this.session) {
      throw new Error('End the current session first');
    }
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
      return this.session;
    } catch (e) {
      await this.api().setSessionActive(false);
      throw e;
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
  async correct(row: Utterance, text: string) {
    if (!this.session || row.session_id !== this.session.id || this.ending) {
      throw new Error('Corrections require the active session');
    }
    await this.queue;
    const source =
      row.speaker === 'A' ? this.session.lang_a : this.session.lang_b;
    const target =
      row.speaker === 'A' ? this.session.lang_b : this.session.lang_a;
    validatePair(source, target);
    const corrected = text.trim();
    if (!corrected) {
      throw new Error('Enter the words actually spoken');
    }
    const value = {
      ...row,
      original_text: corrected,
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
    return value;
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
    } finally {
      await this.api().setSessionActive(false);
    }
  }
}
