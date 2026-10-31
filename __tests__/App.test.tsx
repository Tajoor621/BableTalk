import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import App from '../App';
import { Text } from 'react-native';
jest.mock('../src/audio/pipeline', () => ({ Pipeline: jest.fn() }));
jest.mock('react-native-permissions', () =>
  require('react-native-permissions/mock'),
);
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
it('labels the English-only Phase 1 capabilities honestly', async () => {
  let root: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<App />);
  });
  const json = root!.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .join(' ');
  expect(json).toContain('English microphone test');
  expect(json).toContain(
    'Translation, dialect identification and audio playback arrive in later phases.',
  );
  await act(async () => root!.unmount());
});
