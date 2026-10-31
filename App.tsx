import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { request, PERMISSIONS, RESULTS } from 'react-native-permissions';
import { Pipeline } from './src/audio/pipeline';
import { Conversation } from './src/conversation/engine';
import {
  Language,
  languages,
  languageNotice,
  Speaker,
} from './src/linguistics/languages';
import { downloadModels, verifyModels } from './src/models/store';
import { requireLocal, Route, Voice } from './src/native';
import {
  exportSession,
  sessions,
  Session,
  Utterance,
} from './src/storage/sessions';
const codes = Object.keys(languages) as Language[];
type Tab = 'Conversation' | 'Sessions' | 'Models' | 'Help';
type Work = 'idle' | 'preparing' | 'recording' | 'processing' | 'playing';
function Button({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={secondary ? styles.secondaryText : styles.buttonText}>
        {label}
      </Text>
    </Pressable>
  );
}
function LanguageSelector({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: Language;
  onChange: (value: Language) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.selector}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.wrap}>
        {codes.map(code => (
          <Pressable
            key={code}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected: value === code, disabled }}
            onPress={() => onChange(code)}
            style={[styles.chip, value === code && styles.selected]}
          >
            <Text style={styles.chipText}>{languages[code].native}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
function BabelTalk() {
  const engine = useRef(new Conversation()).current;
  const [tab, setTab] = useState<Tab>('Conversation');
  const [a, setA] = useState<Language>('eng');
  const [b, setB] = useState<Language>('urd');
  const [session, setSession] = useState<Session>();
  const [work, setWork] = useState<Work>('idle');
  const [speaker, setSpeaker] = useState<Speaker>('B');
  const [rows, setRows] = useState<Utterance[]>([]);
  const [saved, setSaved] = useState<Session[]>([]);
  const [viewing, setViewing] = useState<Session>();
  const [savedRows, setSavedRows] = useState<Utterance[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [probability, setProbability] = useState(0);
  const [route, setRoute] = useState<Route>('headphones');
  const [mms, setMms] = useState(false);
  const [useDialect, setUseDialect] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const [typed, setTyped] = useState('');
  const recorder = useRef<Pipeline | undefined>(undefined);
  const pending = useRef<Promise<unknown>[]>([]);
  const busy = useRef(false);
  const foreground = useRef(true);
  const mounted = useRef(true);
  const recordingSpeaker = useRef<Speaker>('B');
  const busyUi = work !== 'idle';
  function updateRow(row: Utterance) {
    if (mounted.current) {
      setRows(old =>
        old.some(x => x.id === row.id)
          ? old.map(x => (x.id === row.id ? row : x))
          : [...old.slice(-499), row],
      );
    }
  }
  function report(e: unknown) {
    if (mounted.current) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function action(operation: () => Promise<void>) {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setError('');
    try {
      await operation();
    } catch (e) {
      report(e);
    } finally {
      busy.current = false;
      if (mounted.current && !recorder.current) {
        setWork('idle');
      }
    }
  }
  async function refresh() {
    await sessions.init();
    setSaved(await sessions.list());
  }
  async function finishRecording(flush = true) {
    const current = recorder.current;
    recorder.current = undefined;
    if (!current) {
      return;
    }
    setWork('processing');
    try {
      await current.stop(flush);
      await Promise.all(pending.current);
    } finally {
      pending.current = [];
      if (mounted.current) {
        setWork('idle');
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (!foreground.current) {
        void engine.stopPlayback().catch(report);
        if (recorder.current) {
          void finishRecording(true).catch(report);
        }
      }
    });
    void refresh().catch(report);
    return () => {
      mounted.current = false;
      foreground.current = false;
      listener.remove();
      void (async () => {
        await finishRecording(false);
        await engine.end();
      })().catch(() => {});
    };
    // Engine and callbacks are held for this screen's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function begin() {
    await action(async () => {
      setWork('preparing');
      await verifyModels('multilingual');
      const value = await engine.start(a, b, { dialect: useDialect });
      setSession(value);
      setRows([]);
      setEditing(undefined);
      setMessage('Session started. Choose whose turn it is.');
    });
  }
  async function record(who: Speaker) {
    await action(async () => {
      if (!engine.session || !foreground.current) {
        throw new Error('Start a session and keep BabelTalk open.');
      }
      if (recorder.current) {
        await finishRecording();
        return;
      }
      setWork('preparing');
      setSpeaker(who);
      recordingSpeaker.current = who;
      const permission =
        Platform.OS === 'ios'
          ? PERMISSIONS.IOS.MICROPHONE
          : PERMISSIONS.ANDROID.RECORD_AUDIO;
      if ((await request(permission)) !== RESULTS.GRANTED) {
        throw new Error(
          'Microphone permission is required. Enable it in Settings.',
        );
      }
      if (!foreground.current) {
        throw new Error('Return to BabelTalk before recording.');
      }
      const source =
        who === 'A' ? engine.session.lang_a : engine.session.lang_b;
      const current = new Pipeline(
        {
          onText: value => {
            const task = engine
              .receive(
                recordingSpeaker.current,
                value.text,
                value.detectedLanguage,
                value.warning,
              )
              .then(updateRow)
              .catch(report);
            pending.current.push(task);
          },
          onVad: p => {
            if (mounted.current) {
              setProbability(p);
            }
          },
          onError: e => {
            report(e);
            if (!busy.current) {
              void finishRecording(false).catch(report);
            }
          },
        },
        { language: source, useMms: mms },
      );
      recorder.current = current;
      try {
        await current.start();
        if (!foreground.current) {
          await finishRecording(false);
        } else {
          setWork('recording');
        }
      } catch (e) {
        recorder.current = undefined;
        await current.stop(false);
        throw e;
      }
    });
  }
  async function end() {
    await action(async () => {
      setWork('processing');
      await finishRecording();
      await engine.end();
      setSession(undefined);
      setMessage('Session saved on this device.');
      await refresh();
    });
  }
  async function play(row: Utterance) {
    await action(async () => {
      if (recorder.current) {
        throw new Error('Stop recording before playback.');
      }
      if (
        Platform.OS === 'android' &&
        Number(Platform.Version) >= 31 &&
        row.speaker === 'B' &&
        route === 'headphones'
      ) {
        if (
          (await request(PERMISSIONS.ANDROID.BLUETOOTH_CONNECT)) !==
          RESULTS.GRANTED
        ) {
          throw new Error(
            'Allow nearby devices to select the headphone output, or select phone speaker.',
          );
        }
      }
      setWork('playing');
      await engine.replay(row, route);
    });
  }
  async function install(includeMms = false) {
    await action(async () => {
      if (session) {
        throw new Error('End the session before model installation.');
      }
      setWork('preparing');
      await downloadModels(
        (file, p) => setMessage(`${file} · ${Math.round(p * 100)}%`),
        includeMms,
      );
      setMessage('Model integrity verified.');
    });
  }
  async function preparePair() {
    await action(async () => {
      if (session) {
        throw new Error('End the session first.');
      }
      if (!languages[a].translation || !languages[b].translation) {
        throw new Error('Pashto translation is not available in this engine.');
      }
      setWork('preparing');
      setMessage('Downloading translation models over Wi-Fi…');
      if (a !== b) {
        await requireLocal().preparePair(languages[a].tag, languages[b].tag);
      }
      await requireLocal().initSpeech();
      setVoices(await requireLocal().offlineVoices());
      setMessage(
        'Pair prepared for local translation. Voice availability is listed below.',
      );
    });
  }
  async function share(value: Session, format: 'json' | 'text') {
    await action(async () => {
      const values = await sessions.read(value.id);
      const content = exportSession(value, values, format);
      // The operating-system share sheet is shown only after an explicit export tap.
      await requireLocal().exportTranscript(
        content,
        format === 'json' ? 'json' : 'txt',
      );
    });
  }
  function confirmDownload(includeMms = false) {
    Alert.alert(
      includeMms
        ? 'Optional audio language identification'
        : 'Download speech models',
      includeMms
        ? 'About 974 MB; high memory use. MMS is licensed CC-BY-NC-4.0. Use only if its non-commercial terms suit your use. Mobile speed is unqualified.'
        : 'About 63 MB. Downloads weights only; no speech or transcripts are sent. Use Wi-Fi.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Download',
          onPress: () => {
            void install(includeMms);
          },
        },
      ],
    );
  }
  const transcript = (item: Utterance, editable: boolean) => (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>
        SPEAKER {item.speaker} · {item.detected_lang} ·{' '}
        {new Date(item.timestamp).toLocaleTimeString()}
      </Text>
      <Text
        selectable
        style={[
          styles.original,
          languages[
            item.speaker === 'A' ? session?.lang_a || a : session?.lang_b || b
          ].rtl && styles.rtl,
        ]}
      >
        {item.original_text}
      </Text>
      <Text selectable style={styles.translation}>
        {item.translated_text ||
          (item.state === 'pending'
            ? 'Translation pending…'
            : 'Translation unavailable')}
      </Text>
      {!!item.warning && <Text style={styles.warning}>{item.warning}</Text>}
      {!!item.detected_dialect && (
        <Text style={styles.note}>
          Arabic dialect candidate: {item.detected_dialect}
        </Text>
      )}
      {editable && (
        <View>
          <View style={styles.wrap}>
            <Button
              secondary
              label="Correct words"
              disabled={busyUi}
              onPress={() => {
                setEditing(item.id);
                setDraft(item.original_text);
              }}
            />
            <Button
              secondary
              label="Play translation"
              disabled={busyUi || item.state !== 'ready'}
              onPress={() => {
                void play(item);
              }}
            />
          </View>
          {editing === item.id && (
            <View>
              <TextInput
                accessibilityLabel="Correct recognised words"
                multiline
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
              />
              <Button
                label="Save correction & translate"
                disabled={busyUi}
                onPress={() => {
                  void action(async () => {
                    setWork('processing');
                    updateRow(await engine.correct(item, draft));
                    setEditing(undefined);
                  });
                }}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor="#101c2d" />
      <View style={styles.header}>
        <Text style={styles.eyebrow}>PRIVATE · ON-DEVICE TRANSLATION</Text>
        <Text accessibilityRole="header" style={styles.title}>
          BabelTalk
        </Text>
        <Text style={styles.subtitle}>A little closer. In your own words.</Text>
      </View>
      <View style={styles.tabs}>
        {(['Conversation', 'Sessions', 'Models', 'Help'] as Tab[]).map(
          value => (
            <Pressable
              key={value}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === value }}
              disabled={busyUi}
              onPress={() => {
                setTab(value);
                if (value === 'Sessions') {
                  void refresh().catch(report);
                }
              }}
              style={[styles.tab, tab === value && styles.activeTab]}
            >
              <Text style={styles.chipText}>{value}</Text>
            </Pressable>
          ),
        )}
      </View>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!!message && (
        <Text accessibilityLiveRegion="polite" style={styles.note}>
          {message}
        </Text>
      )}
      {tab === 'Conversation' && (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <LanguageSelector
            label="A · Your language"
            value={a}
            onChange={setA}
            disabled={!!session || busyUi}
          />
          <LanguageSelector
            label="B · Other speaker"
            value={b}
            onChange={setB}
            disabled={!!session || busyUi}
          />
          {[...new Set([a, b])].map(code =>
            languageNotice(code) ? (
              <Text key={code} style={styles.note}>
                {languageNotice(code)}
              </Text>
            ) : null,
          )}
          <View style={styles.card}>
            <Text style={styles.label}>Your listening output</Text>
            <View style={styles.wrap}>
              {(['headphones', 'speaker'] as Route[]).map(value => (
                <Button
                  key={value}
                  secondary
                  label={
                    value === 'headphones'
                      ? 'Headphones (private)'
                      : 'Phone speaker (audible)'
                  }
                  disabled={busyUi}
                  onPress={() => setRoute(value)}
                />
              ))}
            </View>
            <Text style={styles.note}>
              Selected: {route}. Speaker A’s reply always plays on the phone
              speaker. A headphone routing failure never falls back to speaker.
            </Text>
          </View>
          {!session ? (
            <Button
              label="Start session"
              disabled={busyUi}
              onPress={() => {
                void begin();
              }}
            />
          ) : (
            <View style={styles.card}>
              <Text accessibilityLiveRegion="polite" style={styles.label}>
                {work === 'recording'
                  ? `Recording speaker ${speaker} · VAD ${Math.round(
                      probability * 100,
                    )}%`
                  : work === 'idle'
                  ? 'Ready for the next turn'
                  : work === 'playing'
                  ? 'Playing translation…'
                  : 'Processing…'}
              </Text>
              <View style={styles.wrap}>
                <Button
                  label="A speaks"
                  disabled={busyUi}
                  onPress={() => {
                    void record('A');
                  }}
                />
                <Button
                  label="B speaks"
                  disabled={busyUi}
                  onPress={() => {
                    void record('B');
                  }}
                />
              </View>
              {work === 'recording' && (
                <Button
                  label="Stop & translate"
                  onPress={() => {
                    void action(async () => {
                      await finishRecording();
                    });
                  }}
                />
              )}
              {work === 'playing' && (
                <Button
                  secondary
                  label="Stop playback"
                  onPress={() => {
                    void engine.stopPlayback().catch(report);
                  }}
                />
              )}
              <Button
                secondary
                label="End session & save"
                disabled={busyUi}
                onPress={() => {
                  void end();
                }}
              />
            </View>
          )}
          {!!session && (
            <View style={styles.card}>
              <Text style={styles.label}>Type instead of speaking</Text>
              <TextInput
                accessibilityLabel="Words to translate"
                multiline
                style={styles.input}
                value={typed}
                onChangeText={setTyped}
                editable={!busyUi}
                placeholder="Enter the words actually spoken"
                placeholderTextColor="#a8b8c8"
              />
              <View style={styles.wrap}>
                <Button
                  secondary
                  label="As A"
                  disabled={busyUi || !typed.trim()}
                  onPress={() => {
                    void action(async () => {
                      setWork('processing');
                      updateRow(await engine.receive('A', typed));
                      setTyped('');
                    });
                  }}
                />
                <Button
                  secondary
                  label="As B"
                  disabled={busyUi || !typed.trim()}
                  onPress={() => {
                    void action(async () => {
                      setWork('processing');
                      updateRow(await engine.receive('B', typed));
                      setTyped('');
                    });
                  }}
                />
              </View>
            </View>
          )}
          <Text style={styles.note}>
            Review each turn before playback. Proper names, numbers and
            mixed-language speech need extra care. This app is not a certified
            interpreter.
          </Text>
          {rows.length ? (
            rows.map(row => (
              <View key={row.id}>{transcript(row, !!session)}</View>
            ))
          ) : (
            <Text style={styles.empty}>
              Prepare models once, then start a conversation. Speech and text
              are processed on this device.
            </Text>
          )}
        </ScrollView>
      )}
      {tab === 'Sessions' && (
        <View style={styles.fill}>
          {viewing ? (
            <ScrollView contentContainerStyle={styles.content}>
              <Button
                secondary
                label="Back to saved sessions"
                onPress={() => setViewing(undefined)}
              />
              <Text style={styles.label}>
                {new Date(viewing.start_time).toLocaleString()} ·{' '}
                {viewing.end_time ? 'Ended' : 'Interrupted / open'}
              </Text>
              <View style={styles.wrap}>
                <Button
                  label="Export JSON"
                  onPress={() => {
                    void share(viewing, 'json');
                  }}
                />
                <Button
                  secondary
                  label="Export text"
                  onPress={() => {
                    void share(viewing, 'text');
                  }}
                />
              </View>
              {savedRows.map(row => (
                <View key={row.id}>{transcript(row, false)}</View>
              ))}
            </ScrollView>
          ) : (
            <FlatList
              data={saved}
              keyExtractor={x => x.id}
              ListEmptyComponent={
                <Text style={styles.empty}>No saved conversations yet.</Text>
              }
              renderItem={({ item }) => (
                <View style={styles.card}>
                  <Text style={styles.label}>
                    {languages[item.lang_a]?.name} ↔{' '}
                    {languages[item.lang_b]?.name}
                  </Text>
                  <Text style={styles.note}>
                    {new Date(item.start_time).toLocaleString()} ·{' '}
                    {item.end_time ? 'Ended' : 'Open / interrupted'}
                  </Text>
                  <View style={styles.wrap}>
                    <Button
                      secondary
                      label="Open"
                      disabled={busyUi}
                      onPress={() => {
                        void action(async () => {
                          setSavedRows(await sessions.read(item.id));
                          setViewing(item);
                        });
                      }}
                    />
                    <Button
                      secondary
                      label="Delete"
                      disabled={busyUi || item.id === session?.id}
                      onPress={() =>
                        Alert.alert(
                          'Delete session?',
                          'This removes its transcript from this device.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Delete',
                              style: 'destructive',
                              onPress: () => {
                                void action(async () => {
                                  await sessions.delete(item.id);
                                  await refresh();
                                });
                              },
                            },
                          ],
                        )
                      }
                    />
                  </View>
                </View>
              )}
            />
          )}
        </View>
      )}
      {tab === 'Models' && (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <Text style={styles.label}>1 · Speech recognition</Text>
            <Text style={styles.note}>
              Silero ONNX + multilingual Whisper base quantised. English, Urdu
              and Arabic use a general baseline; Pashto is experimental.
              Specialised checkpoints require conversion and qualification.
            </Text>
            <Button
              label="Download / repair speech models"
              disabled={busyUi || !!session}
              onPress={() => confirmDownload()}
            />
            <Button
              secondary
              label="Verify installed models"
              disabled={busyUi || !!session}
              onPress={() => {
                void action(async () => {
                  setWork('preparing');
                  await verifyModels('multilingual');
                  setMessage('Speech models verified.');
                });
              }}
            />
          </View>
          <View style={styles.card}>
            <Text style={styles.label}>2 · Translation and voices</Text>
            <Text style={styles.note}>
              Selected pair: {languages[a].name} ↔ {languages[b].name}. Uses
              on-device ML Kit translation; downloads require Wi-Fi. No API key
              or cloud translation. SDK/model terms apply.
            </Text>
            <Button
              label="Prepare selected pair"
              disabled={busyUi || !!session}
              onPress={() => {
                void preparePair();
              }}
            />
            <Button
              secondary
              label="Refresh offline voices"
              disabled={busyUi}
              onPress={() => {
                void action(async () => {
                  await requireLocal().initSpeech();
                  setVoices(await requireLocal().offlineVoices());
                });
              }}
            />
            {codes.map(code => (
              <Text key={code} style={styles.note}>
                {languages[code].name}:{' '}
                {voices.some(v => v.language === languages[code].tag)
                  ? 'System voice available; verify in airplane mode'
                  : 'No matching voice listed'}
              </Text>
            ))}
          </View>
          <View style={styles.card}>
            <Text style={styles.label}>Arabic dialect candidate</Text>
            <Text style={styles.note}>
              Uses a build-generated Nawah ONNX pack, when included. At least 25
              words of the same speaker’s Arabic are needed; uncertain results
              receive no label. Missing packs never block translation.
            </Text>
            <View style={styles.switchRow}>
              <Text style={styles.note}>Enable for the next session</Text>
              <Switch
                accessibilityLabel="Enable Arabic dialect classifier"
                value={useDialect}
                disabled={busyUi || !!session}
                onValueChange={setUseDialect}
              />
            </View>
            <Text style={styles.label}>3 · Optional audio language ID</Text>
            <Text style={styles.note}>
              MMS-LID-126 is about 974 MB quantised and has high memory/latency
              demands. Turn language selection works without it. Scores are
              uncalibrated model scores, not ASR certainty. Non-commercial
              licence applies.
            </Text>
            <Button
              secondary
              label="Download optional MMS pack"
              disabled={busyUi || !!session}
              onPress={() => confirmDownload(true)}
            />
            <View style={styles.switchRow}>
              <Text style={styles.note}>Use MMS for the next session</Text>
              <Switch
                accessibilityLabel="Enable optional MMS audio language ID"
                value={mms}
                disabled={busyUi || !!session}
                onValueChange={setMms}
              />
            </View>
          </View>
        </ScrollView>
      )}
      {tab === 'Help' && (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.label}>How to have a conversation</Text>
          <Text style={styles.body}>
            1. In Models, download the speech models and prepare the selected
            translation pair on Wi-Fi.{'\n\n'}2. Select your language (A) and
            the other speaker’s language (B). Connect headphones for private
            listening.{'\n\n'}3. Start a session. Tap B speaks, let the other
            person talk, then Stop & translate. Review the words and tap Play
            translation.{'\n\n'}4. Tap A speaks for your reply. Its translation
            plays through the phone speaker only after you tap Play.{'\n\n'}5.
            End session to finalise the record. Open Sessions to export
            JSON/text or delete it.
          </Text>
          <Text style={styles.label}>Accuracy and dialects</Text>
          <Text style={styles.body}>
            Use one language per turn where possible. Speak in short, complete
            thoughts. Avoid overlapping speech. Confirm names, amounts, dates,
            negation and promises. Short audio is often ambiguous, especially
            Urdu/Hindi or mixed speech. You can correct the recognised words and
            translate again.{'\n\n'}Arabic dialect inference is an optional
            research integration, not a certified label for every short
            utterance. The app preserves the original Arabic; it does not invent
            a dialect-to-MSA dictionary. Urdu, Pashto and English have no
            dialect labels here.{'\n\n'}Pashto currently saves experimental
            transcripts only. Missing translation or voice support is shown
            explicitly.
          </Text>
          <Text style={styles.label}>Offline, privacy and audio</Text>
          <Text style={styles.body}>
            Speech is held in memory and is not saved as audio. Transcripts live
            in a private local SQLite database, outside device backup on iOS and
            with Android backup disabled. They are not separately encrypted by
            this app; use the device lock. Only Export opens the
            operating-system share sheet.{'\n\n'}Model setup uses network
            access. Inference does not call a translation server. After setup,
            verify operation in airplane mode. Installed system voice
            availability varies by phone. No voice is downloaded while speaking.
            {'\n\n'}Both people speak into the phone microphone, even when
            headphones are connected. Recording and playback never run together.
            Android 12+ supports explicit communication-device selection; older
            Android versions support wired output. iOS uses the system audio
            route. Test your Bluetooth/headset combination. Losing a private
            route must show an error, never switch to speaker.{'\n\n'}If
            interrupted by a call or backgrounding, recording stops. Saved open
            sessions remain available for recovery/export. Ask both speakers
            before recording or saving their words.
          </Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <BabelTalk />
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101c2d', paddingHorizontal: 18 },
  header: { paddingVertical: 16 },
  eyebrow: { color: '#76e4cc', fontSize: 11, letterSpacing: 1.1 },
  title: { color: '#fff', fontSize: 34, fontWeight: '700', marginTop: 6 },
  subtitle: { color: '#c3d1e0', fontSize: 15, marginTop: 4 },
  tabs: { flexDirection: 'row', marginBottom: 12 },
  tab: { paddingVertical: 13, flex: 1, alignItems: 'center' },
  activeTab: { borderBottomColor: '#76e4cc', borderBottomWidth: 3 },
  chipText: { color: '#fff', fontSize: 13 },
  selector: { marginVertical: 10 },
  label: { color: '#fff', fontSize: 17, fontWeight: '600', marginBottom: 9 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 14,
    backgroundColor: '#243a52',
  },
  selected: { borderWidth: 2, borderColor: '#76e4cc' },
  card: {
    backgroundColor: '#1b2d43',
    borderRadius: 16,
    padding: 16,
    marginVertical: 9,
  },
  original: { color: '#fff', fontSize: 19, lineHeight: 29, marginVertical: 10 },
  translation: {
    color: '#8debd5',
    fontSize: 19,
    lineHeight: 29,
    marginBottom: 10,
    writingDirection: 'auto',
  },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
  note: { color: '#c3d1e0', fontSize: 12, lineHeight: 19, marginVertical: 4 },
  body: { color: '#d9e3ee', fontSize: 16, lineHeight: 25, marginBottom: 24 },
  warning: {
    color: '#ffdb94',
    fontSize: 13,
    lineHeight: 20,
    marginVertical: 7,
  },
  error: { color: '#ffb6b6', fontSize: 14, lineHeight: 21, marginBottom: 9 },
  button: {
    backgroundColor: '#76e4cc',
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderRadius: 12,
    marginVertical: 5,
  },
  secondary: { backgroundColor: '#2d465f' },
  buttonText: { color: '#101c2d', fontSize: 15, fontWeight: '700' },
  secondaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
  empty: {
    color: '#c3d1e0',
    fontSize: 17,
    lineHeight: 26,
    paddingVertical: 30,
  },
  input: {
    backgroundColor: '#101c2d',
    color: '#fff',
    fontSize: 17,
    borderRadius: 10,
    padding: 13,
    minHeight: 80,
    marginVertical: 10,
    textAlignVertical: 'top',
  },
  content: { paddingBottom: 35 },
  fill: { flex: 1 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
