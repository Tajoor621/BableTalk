#!/usr/bin/env python3
"""Real SQLite schema/round-trip/deletion verification, without native mocks."""
import json
from pathlib import Path
import re
import sqlite3
source=(Path(__file__).resolve().parents[1]/'src/storage/sessions.ts').read_text()
schema=source.split('export const schema = [',1)[1].split('];',1)[0]
statements=[]
for line in schema.splitlines():
    line=line.strip().rstrip(',')
    if line.startswith(('"',"'")):
        statements.append(line[1:-1])
db=sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for statement in statements: db.execute(statement)
db.execute('INSERT INTO sessions(id,start_time,lang_a,lang_b) VALUES(?,?,?,?)',('s',1,'eng','urd'))
text='یہ "حقیقی" الفاظ ہیں; DROP TABLE sessions;'
db.execute('INSERT INTO utterances(id,session_id,speaker,original_text,detected_lang,timestamp) VALUES(?,?,?,?,?,?)',('u','s','B',text,'urd',2))
assert db.execute('SELECT original_text FROM utterances WHERE id=?',('u',)).fetchone()[0]==text
try:
    db.execute('INSERT INTO utterances(id,session_id,speaker,original_text,detected_lang,timestamp) VALUES(?,?,?,?,?,?)',('bad','missing','B','text','eng',2))
    raise AssertionError('Foreign key was not enforced')
except sqlite3.IntegrityError: pass
db.execute('DELETE FROM sessions WHERE id=?',('s',))
assert db.execute('SELECT COUNT(*) FROM utterances').fetchone()[0]==0
assert db.execute('PRAGMA user_version').fetchone()[0]==1
print('SQLite schema, Unicode round trip, parameter safety, foreign keys and cascade delete passed')
