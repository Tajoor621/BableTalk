import { requireSql, SqlApi } from '../native';
import { Language, Speaker } from '../linguistics/languages';
export type Session = {
  id: string;
  start_time: number;
  end_time: number | null;
  lang_a: Language;
  lang_b: Language;
  detected_dialect_a: string | null;
  detected_dialect_b: string | null;
};
export type Utterance = {
  id: string;
  session_id: string;
  speaker: Speaker;
  original_text: string;
  translated_text: string;
  detected_lang: string;
  detected_dialect: string | null;
  timestamp: number;
  state: 'pending' | 'ready' | 'error';
  warning: string;
  revision: number;
};
export const schema = [
  'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, start_time INTEGER NOT NULL, end_time INTEGER, lang_a TEXT NOT NULL, lang_b TEXT NOT NULL, detected_dialect_a TEXT, detected_dialect_b TEXT)',
  "CREATE TABLE IF NOT EXISTS utterances (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, speaker TEXT NOT NULL CHECK(speaker IN ('A','B')), original_text TEXT NOT NULL, translated_text TEXT NOT NULL DEFAULT '', detected_lang TEXT NOT NULL, detected_dialect TEXT, timestamp INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', warning TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0)",
  'CREATE INDEX IF NOT EXISTS utterance_session_time ON utterances(session_id,timestamp,id)',
  'PRAGMA user_version=1',
];
let counter = 0;
export function newId() {
  return `${Date.now().toString(36)}-${(++counter).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}
/** One app-level queue prevents concurrent transactions from interleaving. */
export class Sessions {
  private queue: Promise<unknown> = Promise.resolve();
  private ready = false;
  constructor(private provider: () => SqlApi = requireSql) {}
  private serial<T>(operation: (db: SqlApi) => Promise<T>) {
    const next = this.queue.then(() => operation(this.provider()));
    this.queue = next.catch(() => undefined);
    return next;
  }
  init() {
    return this.serial(async db => {
      if (this.ready) {
        return;
      }
      for (const statement of schema) {
        await db.execute(statement, []);
      }
      this.ready = true;
    });
  }
  create(a: Language, b: Language): Promise<Session> {
    return this.serial(async db => {
      const session: Session = {
        id: newId(),
        start_time: Date.now(),
        end_time: null,
        lang_a: a,
        lang_b: b,
        detected_dialect_a: null,
        detected_dialect_b: null,
      };
      await db.execute(
        'INSERT INTO sessions(id,start_time,lang_a,lang_b) VALUES(?,?,?,?)',
        [session.id, session.start_time, a, b],
      );
      return session;
    });
  }
  add(value: Utterance) {
    return this.serial(async db => {
      const parent = await db.execute(
        'SELECT end_time FROM sessions WHERE id=?',
        [value.session_id],
      );
      if (!parent.rows.length || parent.rows[0].end_time != null) {
        throw new Error('Session is closed or missing');
      }
      await db.execute(
        'INSERT INTO utterances(id,session_id,speaker,original_text,translated_text,detected_lang,detected_dialect,timestamp,state,warning,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [
          value.id,
          value.session_id,
          value.speaker,
          value.original_text,
          value.translated_text,
          value.detected_lang,
          value.detected_dialect,
          value.timestamp,
          value.state,
          value.warning,
          value.revision,
        ],
      );
    });
  }
  update(value: Utterance) {
    return this.serial(async db => {
      await db.execute(
        'UPDATE utterances SET original_text=?,translated_text=?,detected_lang=?,detected_dialect=?,state=?,warning=?,revision=? WHERE id=? AND session_id=?',
        [
          value.original_text,
          value.translated_text,
          value.detected_lang,
          value.detected_dialect,
          value.state,
          value.warning,
          value.revision,
          value.id,
          value.session_id,
        ],
      );
    });
  }
  setDialect(id: string, speaker: Speaker, label: string) {
    return this.serial(async db => {
      const column =
        speaker === 'A' ? 'detected_dialect_a' : 'detected_dialect_b';
      await db.execute(`UPDATE sessions SET ${column}=? WHERE id=?`, [
        label,
        id,
      ]);
    });
  }
  end(id: string) {
    return this.serial(async db => {
      await db.execute(
        'UPDATE sessions SET end_time=? WHERE id=? AND end_time IS NULL',
        [Date.now(), id],
      );
    });
  }
  list(): Promise<Session[]> {
    return this.serial(
      async db =>
        (
          await db.execute(
            'SELECT * FROM sessions ORDER BY start_time DESC LIMIT 200',
            [],
          )
        ).rows as unknown as Session[],
    );
  }
  read(id: string): Promise<Utterance[]> {
    return this.serial(
      async db =>
        (
          await db.execute(
            'SELECT * FROM utterances WHERE session_id=? ORDER BY timestamp,id',
            [id],
          )
        ).rows as unknown as Utterance[],
    );
  }
  delete(id: string) {
    return this.serial(async db => {
      await db.execute('BEGIN IMMEDIATE', []);
      try {
        await db.execute('DELETE FROM utterances WHERE session_id=?', [id]);
        await db.execute('DELETE FROM sessions WHERE id=?', [id]);
        await db.execute('COMMIT', []);
      } catch (e) {
        await db.execute('ROLLBACK', []);
        throw e;
      }
    });
  }
}
export const sessions = new Sessions();
export function exportSession(
  session: Session,
  utterances: Utterance[],
  format: 'json' | 'text',
) {
  if (format === 'json') {
    return JSON.stringify({ schema: 1, session, utterances }, null, 2);
  }
  return [
    `BabelTalk · ${new Date(session.start_time).toISOString()}`,
    `${session.lang_a} ↔ ${session.lang_b}`,
    ...utterances.map(
      row =>
        `${new Date(row.timestamp).toISOString()} · ${row.speaker} · ${
          row.detected_lang
        }\n${row.original_text}\n${row.translated_text || '[No translation]'}${
          row.warning ? '\nNote: ' + row.warning : ''
        }`,
    ),
  ].join('\n\n');
}
