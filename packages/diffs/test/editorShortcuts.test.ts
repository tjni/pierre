import { describe, expect, test } from 'bun:test';

import {
  type EditorShortcutCommand,
  resolveEditorShortcutCommand,
} from '../src/editor/editorShortcuts';

type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key'
>;
type ShortcutCase = {
  event: Partial<ShortcutKeyboardEvent> & Pick<ShortcutKeyboardEvent, 'key'>;
  expected: EditorShortcutCommand | undefined;
};

function event({
  key,
  ...overrides
}: Partial<ShortcutKeyboardEvent> &
  Pick<ShortcutKeyboardEvent, 'key'>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
    key,
  } as KeyboardEvent;
}

function withPlatform(platform: string, run: () => void): void {
  const navigator = globalThis.navigator;
  const originalPlatform = navigator.platform;
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: platform,
  });

  try {
    run();
  } finally {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  }
}

function expectShortcuts(platform: string, cases: ShortcutCase[]): void {
  withPlatform(platform, () => {
    for (const { event: shortcutEvent, expected } of cases) {
      expect(resolveEditorShortcutCommand(event(shortcutEvent))).toBe(expected);
    }
  });
}

describe('resolveEditorShortcutCommand', () => {
  test('uses command shortcuts on macOS', () => {
    expectShortcuts('MacIntel', [
      { event: { key: 'c', metaKey: true }, expected: 'copy' },
      { event: { key: 'x', metaKey: true }, expected: 'cut' },
      { event: { key: 'v', metaKey: true }, expected: 'paste' },
      { event: { key: 'z', metaKey: true }, expected: 'undo' },
      { event: { key: 'z', metaKey: true, shiftKey: true }, expected: 'redo' },
      { event: { key: 'a', metaKey: true }, expected: 'selectAll' },
      { event: { key: 'ArrowUp', metaKey: true }, expected: 'documentStart' },
      { event: { key: 'ArrowDown', metaKey: true }, expected: 'documentEnd' },
    ]);
  });

  test('uses control shortcuts on windows and linux', () => {
    expectShortcuts('Linux x86_64', [
      { event: { key: 'c', ctrlKey: true }, expected: 'copy' },
      { event: { key: 'x', ctrlKey: true }, expected: 'cut' },
      { event: { key: 'v', ctrlKey: true }, expected: 'paste' },
      { event: { key: 'z', ctrlKey: true }, expected: 'undo' },
      { event: { key: 'z', ctrlKey: true, shiftKey: true }, expected: 'redo' },
      { event: { key: 'y', ctrlKey: true }, expected: 'redo' },
      { event: { key: 'a', ctrlKey: true }, expected: 'selectAll' },
      { event: { key: 'Home', ctrlKey: true }, expected: 'documentStart' },
      { event: { key: 'End', ctrlKey: true }, expected: 'documentEnd' },
    ]);
  });

  test('ignores modified alt shortcuts and unsupported navigation', () => {
    expectShortcuts('Linux x86_64', [
      { event: { key: 'ArrowUp', ctrlKey: true }, expected: undefined },
      { event: { key: 'z', ctrlKey: true, altKey: true }, expected: undefined },
    ]);
  });

  test('maps tab and shift+tab without primary modifier', () => {
    expectShortcuts('Linux x86_64', [
      { event: { key: 'Tab' }, expected: 'indent' },
      { event: { key: 'Tab', shiftKey: true }, expected: 'outdent' },
      { event: { key: 'Tab', ctrlKey: true }, expected: undefined },
    ]);
  });
});
