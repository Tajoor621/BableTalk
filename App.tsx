import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  FlatList,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { request, PERMISSIONS, RESULTS } from 'react-native-permissions';
import { Pipeline, Transcript } from './src/audio/pipeline';
type Status = 'idle' | 'loading' | 'listening' | 'stopping' | 'error';
function Conversation() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [rows, setRows] = useState<Transcript[]>([]);
  const [vad, setVad] = useState({ probability: 0, speaking: false });
  const pipeline = useRef<Pipeline | null>(null);
  const busy = useRef(false);
  const foreground = useRef(true);
  const mounted = useRef(true);
  async function stop() {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setStatus('stopping');
    const current = pipeline.current;
    pipeline.current = null;
    try {
      await current?.stop();
      if (mounted.current) {
        setStatus('idle');
      }
    } catch (e) {
      if (mounted.current) {
        setError(String(e));
        setStatus('error');
      }
    } finally {
      busy.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (!foreground.current && !busy.current && pipeline.current) {
        void stop();
      }
    });
    return () => {
      mounted.current = false;
      foreground.current = false;
      sub.remove();
      if (!busy.current) {
        const current = pipeline.current;
        pipeline.current = null;
        void current?.stop(false).catch(() => {});
      }
    };
  }, []);
  async function start() {
    if (busy.current || pipeline.current) {
      return;
    }
    busy.current = true;
    setError('');
    setStatus('loading');
    const current = new Pipeline({
      onText: value => {
        if (mounted.current) {
          setRows(old => [...old.slice(-499), value]);
        }
      },
      onVad: (probability, speaking) => {
        if (mounted.current) {
          setVad({ probability, speaking });
        }
      },
      onError: e => {
        if (mounted.current) {
          setError(e.message);
          setStatus('error');
        }
        // start/stop owns cleanup while busy; during capture, release immediately.
        if (!busy.current) {
          void stopAfterError();
        }
      },
    });
    try {
      const permission =
        Platform.OS === 'ios'
          ? PERMISSIONS.IOS.MICROPHONE
          : PERMISSIONS.ANDROID.RECORD_AUDIO;
      if ((await request(permission)) !== RESULTS.GRANTED) {
        throw new Error(
          'Microphone access is required. Enable it in device Settings.',
        );
      }
      if (!foreground.current) {
        throw new Error('Return to BabelTalk before starting.');
      }
      pipeline.current = current;
      await current.start();
      if (!foreground.current || !mounted.current) {
        await current.stop(false);
        pipeline.current = null;
        if (mounted.current) {
          setStatus('idle');
        }
      } else {
        setRows([]);
        setStatus('listening');
      }
    } catch (e) {
      try {
        await current.stop(false);
      } finally {
        pipeline.current = null;
      }
      if (mounted.current) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    } finally {
      busy.current = false;
    }
  }
  async function stopAfterError() {
    busy.current = true;
    const current = pipeline.current;
    pipeline.current = null;
    try {
      await current?.stop(false);
    } catch (e) {
      if (mounted.current) {
        setError(String(e));
      }
    } finally {
      busy.current = false;
    }
  }
  const active = status === 'listening';
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor="#101c2d" />
      <View style={styles.header}>
        <Text style={styles.eyebrow}>PRIVATE · ON DEVICE</Text>
        <Text accessibilityRole="header" style={styles.title}>
          BabelTalk
        </Text>
        <Text style={styles.subtitle}>Understand each other.</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>English microphone test</Text>
        <Text style={styles.body}>Phase 1 · Speech recognition</Text>
        <Text style={styles.body}>English → English transcript</Text>
        <Text style={styles.note}>
          Translation, dialect identification and audio playback arrive in later
          phases.
        </Text>
      </View>
      <View style={styles.statusRow}>
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {status === 'loading'
            ? 'Checking models…'
            : status === 'stopping'
            ? 'Finishing transcription…'
            : active
            ? vad.speaking
              ? 'Speech detected'
              : 'Listening…'
            : 'Microphone off'}
        </Text>
        {active && (
          <Text style={styles.note}>
            VAD {Math.round(vad.probability * 100)}%
          </Text>
        )}
      </View>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={x => String(x.id)}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Your words will appear here. Speak naturally, then pause briefly.
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.utterance}>
            <Text style={styles.eyebrow}>
              SPEAKER B · ENGLISH · {(item.endMs / 1000).toFixed(1)}s
            </Text>
            <Text selectable style={styles.transcript}>
              {item.text}
            </Text>
            <Text style={styles.note}>
              {item.processingMs} ms queue + recognition
            </Text>
          </View>
        )}
      />
      <Text style={styles.note}>
        Audio stays in memory. Transcripts clear when the app closes. Most
        recent 500 turns shown.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={active ? 'End session' : 'Start English session'}
        disabled={status === 'loading' || status === 'stopping'}
        onPress={() => {
          if (active) {
            void stop();
          } else {
            void start();
          }
        }}
        style={({ pressed }) => [
          styles.button,
          active && styles.stopButton,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.buttonText}>
          {active
            ? 'End session'
            : status === 'loading'
            ? 'Preparing…'
            : 'Start English session'}
        </Text>
      </Pressable>
      <Text style={styles.footer}>
        Offline after model installation · No account needed
      </Text>
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <Conversation />
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101c2d', paddingHorizontal: 22 },
  header: { paddingVertical: 24 },
  eyebrow: { color: '#6cdec5', fontSize: 11, letterSpacing: 1.4 },
  title: { color: '#ffffff', fontSize: 38, fontWeight: '700', marginTop: 8 },
  subtitle: { color: '#b9c9da', fontSize: 17, marginTop: 6 },
  card: { backgroundColor: '#1b2d43', borderRadius: 18, padding: 18 },
  cardTitle: {
    color: '#fff',
    fontSize: 19,
    fontWeight: '600',
    marginBottom: 6,
  },
  body: { color: '#d4dfeb', fontSize: 15, marginBottom: 5 },
  note: { color: '#b9c9da', fontSize: 12, lineHeight: 18 },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 18,
  },
  status: { color: '#6cdec5', fontSize: 15 },
  error: { color: '#ffb6b6', marginBottom: 12 },
  list: { flex: 1 },
  empty: { color: '#b9c9da', fontSize: 17, lineHeight: 26, paddingTop: 36 },
  utterance: {
    backgroundColor: '#1b2d43',
    padding: 16,
    borderRadius: 14,
    marginBottom: 12,
  },
  transcript: {
    color: '#fff',
    fontSize: 20,
    lineHeight: 29,
    paddingVertical: 8,
  },
  button: {
    backgroundColor: '#6cdec5',
    paddingVertical: 17,
    alignItems: 'center',
    borderRadius: 14,
    marginTop: 16,
  },
  stopButton: { backgroundColor: '#ffb6b6' },
  pressed: { opacity: 0.75 },
  buttonText: { color: '#101c2d', fontSize: 17, fontWeight: '700' },
  footer: {
    color: '#b9c9da',
    textAlign: 'center',
    fontSize: 11,
    paddingVertical: 12,
  },
});
