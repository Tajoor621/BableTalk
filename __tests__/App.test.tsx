import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import App from '../App';
import { Text } from 'react-native';
jest.mock('../src/models/store', () => ({
  verifyModels: jest.fn(),
  downloadModels: jest.fn(),
}));
jest.mock('../src/storage/sessions', () => ({
  sessions: { init: jest.fn(async () => {}), list: jest.fn(async () => []) },
}));
jest.mock('../src/audio/pipeline', () => ({ Pipeline: jest.fn() }));
jest.mock('react-native-permissions', () =>
  require('react-native-permissions/mock'),
);
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
it('shows the functional conversation interface and explicit language support', async () => {
  let root: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<App />);
  });
  const json = root!.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .join(' ');
  expect(json).toContain('BabelTalk');
  expect(json).toContain('Start session');
  expect(json).toContain('Urdu language identification only.');
  await act(async () => root!.unmount());
});
