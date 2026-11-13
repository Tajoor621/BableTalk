import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  DeviceEventEmitter,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PERMISSIONS, request, RESULTS } from 'react-native-permissions';
import { Pipeline } from '../audio/pipeline';
import { Language, languages, scriptNotice, sentenceChunks } from '../linguistics/languages';
import { requireLocal } from '../native';
import {
  importTranscript,
  pickPhoto,
  pickText,
  screenAudioAvailable,
  screenAudioSource,
  translateDocument,
} from './media';

const options = Object.keys(languages) as Language[];
const modes = ['Text', 'Photo', 'Audio file', 'Live voice', 'Screen audio'] as const;
type Mode = typeof modes[number];

function Choice({ label, onPress, disabled, selected }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, selected && styles.selected, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function TranslateWindow({ initialSource, initialTarget, onClose }: {
  initialSource: Language;
  initialTarget: Language;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('Text');
  const [source, setSource] = useState(initialSource);
  const [target, setTarget] = useState(initialTarget);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playback = useRef(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const operation = useRef(false);
  const live = useRef<{ pipeline: Pipeline; screen: boolean } | null>(null);
  const work = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const canTranslate = source === target ||
    (languages[source].translation && languages[target].translation);
  const locked = busy || recording;

  function report(reason: unknown) {
    if (mounted.current) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function run(task: () => Promise<void>) {
    if (operation.current) {
      return;
    }
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (reason) {
      setStatus('');
      report(reason);
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  }

  async function stop(flush: boolean) {
    const current = live.current;
    if (!current) {
      return;
    }
    try {
      await current.pipeline.stop(flush);
      await work.current;
    } finally {
      if (live.current === current) {
        live.current = null;
      }
      if (mounted.current) {
        setRecording(false);
        setStatus('Capture finished. Review the transcript below.');
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    const ended = DeviceEventEmitter.addListener('BabelScreenEnded', (message: string) => {
      if (live.current?.screen) {
        report(message);
        void stop(true).catch(report);
      }
    });
    const state = AppState.addEventListener('change', value => {
      if (value !== 'active' && live.current && !live.current.screen) {
        void stop(true).catch(report);
      }
    });
    return () => {
      mounted.current = false;
      ended.remove();
      state.remove();
      void stop(false).catch(() => {});
    };
    // The listeners read the current capture through its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateInput(value: string) {
    setInput(value);
    setOutput('');
  }

  async function start(screen: boolean) {
    if (live.current) {
      return;
    }
    setStatus('Preparing speech recognition…');
    const permission = Platform.OS === 'ios' ? PERMISSIONS.IOS.MICROPHONE : PERMISSIONS.ANDROID.RECORD_AUDIO;
    if ((await request(permission)) !== RESULTS.GRANTED) {
      throw new Error('Allow audio recording in device Settings to use this input.');
    }
    let translateLive = canTranslate;
    if (translateLive && source !== target) {
      translateLive = await requireLocal().pairReady(languages[source].tag, languages[target].tag);
    }
    if (!screen && AppState.currentState !== 'active') {
      throw new Error('Return to BabelTalk before starting live voice capture.');
    }
    updateInput('');
    work.current = Promise.resolve();
    const pipeline = new Pipeline({
      onText: segment => {
        if (!mounted.current) {
          return;
        }
        setInput(previous => previous ? previous + '\n' + segment.text : segment.text);
        if (translateLive) {
          work.current = work.current.then(async () => {
            if (!mounted.current) {
              return;
            }
            const result = await translateDocument(segment.text, source, target);
            if (mounted.current) {
              setOutput(previous => previous ? previous + '\n' + result : result);
            }
          }).catch(report);
        }
      },
      onVad: () => {},
      onError: reason => {
        report(reason);
        void stop(false).catch(report);
      },
    }, { language: source, source: screen ? screenAudioSource() : undefined });
    live.current = { pipeline, screen };
    try {
      await pipeline.start();
      if (!mounted.current || live.current?.pipeline !== pipeline) {
        return;
      }
      setRecording(true);
      setStatus(translateLive
        ? screen ? 'Screen audio is active. Return here or use Android’s screen-sharing controls to stop.' : 'Listening to the phone microphone…'
        : 'Transcribing. Prepare the selected pair to translate afterwards.');
    } catch (reason) {
      await stop(false);
      throw reason;
    }
  }

  async function loadInput() {
    setStatus(mode === 'Audio file' ? 'Choose a recording to transcribe…' : 'Choose a file…');
    const value = mode === 'Photo' ? await pickPhoto(source)
      : mode === 'Audio file' ? await importTranscript(source)
      : await pickText();
    if (value === null) {
      setStatus('');
      return;
    }
    if (!value.trim()) {
      throw new Error('No readable text was found in the selected file.');
    }
    updateInput(value);
    setStatus('Review the recognised text, then translate.');
  }

  async function play(value: string, language: Language) {
    const local = requireLocal();
    playback.current = true;
    setPlaying(true);
    try {
      await local.initSpeech();
      for (const chunk of sentenceChunks(value)) {
        if (!playback.current) {
          break;
        }
        await local.speak(chunk, languages[language].tag, 'speaker');
      }
    } catch (reason) {
      if (playback.current) {
        throw reason;
      }
    } finally {
      playback.current = false;
      if (mounted.current) {
        setPlaying(false);
      }
    }
  }

  function selectLanguage(label: string, value: Language, select: (language: Language) => void) {
    return (
      <View>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.row}>
          {options.map(language => (
            <Choice key={language} label={languages[language].native}
              selected={language === value} disabled={locked}
              onPress={() => { select(language); setOutput(''); setError(''); }} />
          ))}
        </View>
      </View>
    );
  }

  const warning = scriptNotice(input, source);
  return (
    <Modal visible animationType="slide" onRequestClose={() => { if (!locked) onClose(); }}>
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.row}>
            <Text accessibilityRole="header" style={styles.title}>Translate</Text>
            <Choice label="Close" disabled={locked} onPress={onClose} />
          </View>
          <View style={styles.row}>
            {modes.map(item => (
              <Choice key={item} label={item} selected={mode === item} disabled={locked}
                onPress={() => { setMode(item); setError(''); setStatus(''); }} />
            ))}
          </View>
          {selectLanguage('From', source, setSource)}
          {selectLanguage('To', target, setTarget)}
          {!canTranslate && <Text style={styles.note}>Pashto supports transcription and review.</Text>}
          {mode === 'Screen audio' && (
            <Text style={styles.note}>
              {screenAudioAvailable
                ? 'Android captures permitted media playback after you approve sharing. Captions appear here.'
                : 'Screen audio is available on Android 10 and later. Use Audio file or Live voice on this device.'}
            </Text>
          )}
          <View style={styles.row}>
            {mode === 'Text' || mode === 'Photo' || mode === 'Audio file' ? (
              <Choice label={mode === 'Text' ? 'Open text file' : mode === 'Photo' ? 'Read photo' : 'Transcribe recording'}
                disabled={locked} onPress={() => { void run(loadInput); }} />
            ) : (
              <Choice label={recording ? 'Stop capture' : 'Start capture'}
                disabled={busy || (mode === 'Screen audio' && !screenAudioAvailable)}
                onPress={() => {
                  void run(() => recording ? stop(true) : start(mode === 'Screen audio'));
                }} />
            )}
            <Choice label="Download pair" disabled={locked || !canTranslate || source === target}
              onPress={() => {
                void run(async () => {
                  await requireLocal().preparePair(languages[source].tag, languages[target].tag);
                  setStatus('The language pair is ready for offline translation.');
                });
              }} />
          </View>
          {!!status && <Text accessibilityLiveRegion="polite" style={styles.note}>{status}</Text>}
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          <Text style={styles.label}>Source text or transcript</Text>
          <TextInput accessibilityLabel="Source text or transcript" multiline editable={!locked}
            placeholder="Type, paste, or import text" placeholderTextColor="#a5b9cb"
            value={input} onChangeText={updateInput}
            style={[styles.input, languages[source].rtl && styles.rtl]} />
          {!!warning && <Text style={styles.note}>{warning}</Text>}
          <View style={styles.row}>
            <Choice label="Translate" disabled={locked || !input.trim() || !canTranslate}
              onPress={() => {
                void run(async () => {
                  setOutput(await translateDocument(input, source, target));
                  setStatus('');
                });
              }} />
            <Choice label="Read source aloud" disabled={locked || !input.trim()}
              onPress={() => { void run(() => play(input, source)); }} />
          </View>
          <Text style={styles.label}>Translation</Text>
          <Text selectable style={[styles.output, languages[target].rtl && styles.rtl]}>{output}</Text>
          <View style={styles.row}>
            <Choice label="Read translation aloud" disabled={locked || !output.trim()}
              onPress={() => { void run(() => play(output, target)); }} />
            {playing && <Choice label="Stop playback" onPress={() => {
              playback.current = false;
              void requireLocal().stopSpeech().catch(report);
            }} />}
            <Choice label="Export text" disabled={locked || !input.trim()}
              onPress={() => {
                void run(async () => {
                  await requireLocal().exportTranscript(output ? input + '\n\n' + output : input, 'txt');
                });
              }} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101c2d' },
  content: { padding: 18, gap: 12, paddingBottom: 32 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 30, color: '#fff', fontWeight: '700' },
  label: { color: '#e3edf6', fontSize: 15, fontWeight: '600', marginBottom: 5 },
  button: { backgroundColor: '#20384f', paddingHorizontal: 12, minHeight: 44, justifyContent: 'center', borderRadius: 8 },
  selected: { backgroundColor: '#236258' },
  disabled: { opacity: 0.45 },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  note: { color: '#c3d1e0', fontSize: 14 },
  error: { color: '#ffb9a9', fontSize: 14 },
  input: { color: '#fff', fontSize: 16, backgroundColor: '#1a3046', borderRadius: 8, minHeight: 120, padding: 12, textAlignVertical: 'top' },
  output: { color: '#f0f8ff', fontSize: 17, backgroundColor: '#1a3046', borderRadius: 8, minHeight: 60, padding: 12 },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
});
