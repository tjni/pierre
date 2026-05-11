export type EditorCommand =
  | 'indent'
  | 'outdent'
  | 'documentStart'
  | 'documentEnd'
  | 'undo'
  | 'redo'
  | 'selectAll'
  | 'extendSelection';

const SHORTCUTS: Partial<Record<string, EditorCommand>> = {
  a: 'selectAll',
  d: 'extendSelection',
};

export function resolveEditorCommandFromKeyboardEvent(
  event: KeyboardEvent
): EditorCommand | undefined {
  const hasPrimaryModifier = isPrimaryModifier(event);
  const { shiftKey, altKey, key } = event;
  if (altKey) {
    return undefined;
  }

  const isMac = isMacLike();
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
    return 'documentStart';
  }

  if (normalizedKey === 'End' || (isMac && normalizedKey === 'ArrowDown')) {
    return 'documentEnd';
  }

  return SHORTCUTS[normalizedKey];
}

export function isPrimaryModifier({
  metaKey,
  ctrlKey,
}: MouseEvent | KeyboardEvent): boolean {
  return isMacLike() ? metaKey && !ctrlKey : ctrlKey && !metaKey;
}

function isMacLike(): boolean {
  return /macOS|MacIntel|iPhone|iPad|iPod/i.test(getPlatform());
}

function getPlatform(): string {
  const navigator = globalThis.navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return navigator?.platform ?? navigator?.userAgentData?.platform ?? 'unknown';
}
