import { Conversation } from '../src/conversation/engine';
import { LocalApi } from '../src/native';
import {
  Sessions,
  Session,
  Utterance,
  exportSession,
} from '../src/storage/sessions';
function fixture() {
  let session: Session;
  const db = {
    init: jest.fn(async () => {}),
    create: jest.fn(async (a, b) => {
      session = {
        id: 's',
        start_time: 1,
        end_time: null,
        lang_a: a,
        lang_b: b,
        detected_dialect_a: null,
        detected_dialect_b: null,
      };
      return session;
    }),
    add: jest.fn(async () => {}),
    update: jest.fn(async () => {}),
    end: jest.fn(async () => {}),
  };
  const api = {
    exportTranscript: jest.fn(async () => true),
    pairReady: jest.fn(async () => true),
    translate: jest.fn(async (text, a, b) => `${a}:${text}:${b}`),
    setSessionActive: jest.fn(async () => true),
    initSpeech: jest.fn(async () => true),
    speak: jest.fn(async () => true),
    stopSpeech: jest.fn(async () => true),
    preparePair: jest.fn(async () => true),
    offlineVoices: jest.fn(async () => []),
  };
  const engine = new Conversation(
    db as unknown as Sessions,
    () => api as LocalApi,
  );
  return { db, api, engine };
}
it('routes both directions using ISO-to-BCP47 conversion and preserves the original', async () => {
  const { db, api, engine } = fixture();
  await engine.start('eng', 'urd');
  const b = await engine.receive('B', 'آپ کیسے ہیں؟');
  const a = await engine.receive('A', 'I am fine.');
  expect(api.translate).toHaveBeenNthCalledWith(1, 'آپ کیسے ہیں؟', 'ur', 'en');
  expect(api.translate).toHaveBeenNthCalledWith(2, 'I am fine.', 'en', 'ur');
  expect(b.original_text).toBe('آپ کیسے ہیں؟');
  expect(a.state).toBe('ready');
  expect(db.add).toHaveBeenCalledTimes(2);
});
it('never falls back to speaker if private playback fails', async () => {
  const { api, engine } = fixture();
  await engine.start('eng', 'ara');
  const row = await engine.receive('B', 'مرحبا بك');
  api.speak.mockRejectedValueOnce(new Error('headphones missing'));
  await expect(engine.replay(row, 'headphones')).rejects.toThrow(
    'headphones missing',
  );
  expect(api.speak).toHaveBeenCalledTimes(1);
  expect(api.speak).toHaveBeenCalledWith(
    expect.any(String),
    'en',
    'headphones',
  );
});
it('plays A replies only through the speaker', async () => {
  const { api, engine } = fixture();
  await engine.start('eng', 'ara');
  const row = await engine.receive('A', 'Hello');
  await engine.replay(row, 'headphones');
  expect(api.speak).toHaveBeenCalledWith(expect.any(String), 'ar', 'speaker');
});
it('saves untranslated Pashto and explicitly avoids unsupported translation', async () => {
  const { api, engine, db } = fixture();
  await engine.start('eng', 'pus');
  const row = await engine.receive('B', 'سلام');
  expect(row.state).toBe('error');
  expect(row.warning).toContain('transcription only');
  expect(api.translate).not.toHaveBeenCalled();
  expect(db.add).toHaveBeenCalled();
});
it('holds mismatched language detection for review', async () => {
  const { api, engine } = fixture();
  await engine.start('eng', 'urd');
  const row = await engine.receive('B', 'مرحبا', 'ara');
  expect(row.state).toBe('error');
  expect(row.detected_lang).toBe('ara');
  expect(api.translate).not.toHaveBeenCalled();
});
it('retains original text when native translation fails', async () => {
  const { api, engine, db } = fixture();
  await engine.start('eng', 'urd');
  api.translate.mockRejectedValueOnce(new Error('model missing'));
  const row = await engine.receive('B', 'یہ الفاظ محفوظ ہیں');
  expect(row.original_text).toBe('یہ الفاظ محفوظ ہیں');
  expect(row.state).toBe('error');
  expect(db.update).toHaveBeenCalled();
});
it('waits for queued turns before finalising the session and rejects later turns', async () => {
  const { engine, db, api } = fixture();
  await engine.start('eng', 'urd');
  const pending = engine.receive('A', 'One');
  const end = engine.end();
  await pending;
  await end;
  expect(db.end).toHaveBeenCalledWith('s');
  expect(api.setSessionActive).toHaveBeenLastCalledWith(false);
  await expect(engine.receive('B', 'late')).rejects.toThrow(
    'No active session',
  );
});
it('regenerates translations after explicit text correction', async () => {
  const { engine, api } = fixture();
  await engine.start('eng', 'urd');
  const row = await engine.receive('A', 'fifteen');
  const corrected = await engine.correct(row, 'fifty');
  expect(corrected.original_text).toBe('fifty');
  expect(corrected.revision).toBe(1);
  expect(api.translate).toHaveBeenLastCalledWith('fifty', 'en', 'ur');
});
it('does not start translation when model preparation is incomplete', async () => {
  const { engine, api, db } = fixture();
  api.pairReady.mockResolvedValue(false);
  await expect(engine.start('eng', 'urd')).rejects.toThrow('Download');
  expect(db.create).not.toHaveBeenCalled();
});
it('exports both texts as valid JSON without changing script or quotes', () => {
  const session = {
    id: 's',
    start_time: 1,
    end_time: 2,
    lang_a: 'eng',
    lang_b: 'urd',
    detected_dialect_a: null,
    detected_dialect_b: null,
  } as Session;
  const row = {
    id: 'u',
    session_id: 's',
    speaker: 'B',
    original_text: 'یہ "حقیقی" الفاظ ہیں',
    translated_text: 'Real words',
    detected_lang: 'urd',
    detected_dialect: null,
    timestamp: 1,
    state: 'ready',
    warning: '',
    revision: 0,
  } as Utterance;
  const result = JSON.parse(exportSession(session, [row], 'json'));
  expect(result.utterances[0].original_text).toBe(row.original_text);
  expect(exportSession(session, [row], 'text')).toContain(row.original_text);
});
it('only assigns Arabic dialect candidates after enough same-speaker context', async () => {
  const { db, api } = fixture();
  const setDialect = jest.fn(async () => {});
  Object.assign(db, { setDialect });
  const model = {
    classify: jest.fn(async () => ({
      label: 'Egyptian',
      warning: 'Candidate only',
    })),
    release: jest.fn(async () => {}),
  };
  const factory = jest.fn(async () => model);
  const engine = new Conversation(
    db as unknown as Sessions,
    () => api as LocalApi,
    factory,
  );
  await engine.start('eng', 'ara', { dialect: true });
  const short = await engine.receive('B', 'مرحبا كيف حالك');
  expect(short.detected_dialect).toBeNull();
  expect(factory).not.toHaveBeenCalled();
  const long = await engine.receive('B', 'كلمة '.repeat(30));
  expect(long.detected_dialect).toBe('Egyptian');
  expect(setDialect).toHaveBeenCalledWith('s', 'B', 'Egyptian');
  await engine.end();
  expect(model.release).toHaveBeenCalledTimes(1);
});
it('does not create dialect labels for Urdu even when dialect mode is enabled', async () => {
  const { db, api } = fixture();
  const factory = jest.fn();
  const engine = new Conversation(
    db as unknown as Sessions,
    () => api as LocalApi,
    factory,
  );
  await engine.start('eng', 'urd', { dialect: true });
  const row = await engine.receive('B', 'الفاظ '.repeat(30));
  expect(row.detected_dialect).toBeNull();
  expect(factory).not.toHaveBeenCalled();
});
it('prevents simultaneous session starts', async () => {
  const { engine } = fixture();
  const first = engine.start('eng', 'urd');
  await expect(engine.start('eng', 'ara')).rejects.toThrow('End');
  await first;
});
