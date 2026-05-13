import { isMacLike, isPrimaryModifier } from './platform';

export type EditorCommand =
  | 'indent'
  | 'outdent'
  | 'undo'
  | 'redo'
  | 'selectAll'
  | 'findNextMatch'
  | 'moveCursorToDocStart'
  | 'moveCursorToDocEnd';

const SHORTCUTS: Partial<Record<string, EditorCommand>> = {
  a: 'selectAll',
  d: 'findNextMatch',
};

export function resolveEditorCommandFromKeyboardEvent(
  event: KeyboardEvent,
  isMac: boolean = isMacLike()
): EditorCommand | undefined {
  const hasPrimaryModifier = isPrimaryModifier(event, isMac);
  const { shiftKey, altKey, key } = event;
  if (altKey) {
    return undefined;
  }

  const normalizedKey = key.length === 1 ? key.toLowerCase() : key;

  if (!hasPrimaryModifier && normalizedKey === 'Tab') {
    return shiftKey ? 'outdent' : 'indent';
  }

  if (!hasPrimaryModifier) {
    return undefined;
  }

  if (normalizedKey === 'z') {
    return shiftKey ? 'redo' : 'undo';
  }

  if (!isMac && normalizedKey === 'y') {
    return 'redo';
  }

  if (normalizedKey === 'Home' || (isMac && normalizedKey === 'ArrowUp')) {
    return 'moveCursorToDocStart';
  }

  if (normalizedKey === 'End' || (isMac && normalizedKey === 'ArrowDown')) {
    return 'moveCursorToDocEnd';
  }

  return SHORTCUTS[normalizedKey];
}
