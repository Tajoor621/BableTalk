import { NativeModules } from 'react-native';
export type Route = 'headphones' | 'speaker';
export type Voice = { language: string; name: string };
export interface LocalApi {
  preparePair(a: string, b: string): Promise<boolean>;
  pairReady(a: string, b: string): Promise<boolean>;
  translate(text: string, a: string, b: string): Promise<string>;
  setSessionActive(active: boolean): Promise<boolean>;
  initSpeech(): Promise<boolean>;
  offlineVoices(): Promise<Voice[]>;
  speak(text: string, lang: string, route: Route): Promise<boolean>;
  stopSpeech(): Promise<boolean>;
}
export const local = NativeModules.BabelLocal as LocalApi | undefined;
export function requireLocal(): LocalApi {
  if (!local) {
    throw new Error(
      'Native language module is missing. Install a new native build.',
    );
  }
  return local;
}
export type Scalar = string | number | boolean | null;
export interface SqlApi {
  execute(
    sql: string,
    params: Scalar[],
  ): Promise<{ rows: Record<string, Scalar>[] }>;
}
export function requireSql(): SqlApi {
  const sql = NativeModules.BabelStorage as SqlApi | undefined;
  if (!sql) {
    throw new Error(
      'Native SQLite module is missing. Install a new native build.',
    );
  }
  return sql;
}
