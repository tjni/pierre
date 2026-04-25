export type EditorCommand =
  | 'copy'
  | 'cut'
  | 'paste'
  | 'indent'
  | 'outdent'
  | 'documentStart'
  | 'documentEnd'
  | 'undo'
  | 'redo'
  | 'selectAll';

const SHORTCUTS: Partial<Record<string, EditorCommand>> = {
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
};

function isMacLike(): boolean {
  return /macOS|MacIntel|iPhone|iPad|iPod/i.test(getPlatform());
}

export function getPrimaryModifier(event: MouseEvent | KeyboardEvent): boolean {
  return isMacLike()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function resolveEditorCommandFromKeyboardEvent(
  event: KeyboardEvent
): EditorCommand | undefined {
  if (event.altKey) {
    return undefined;
  }

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const hasPrimaryModifier = getPrimaryModifier(event);
  const isMac = isMacLike();

  if (!hasPrimaryModifier && key === 'Tab') {
    return event.shiftKey ? 'outdent' : 'indent';
  }

  if (!hasPrimaryModifier) {
    return undefined;
  }

  if (key === 'z') {
    return event.shiftKey ? 'redo' : 'undo';
  }

  if (!isMac && key === 'y') {
    return 'redo';
  }

  if (key === 'Home' || (isMac && key === 'ArrowUp')) {
    return 'documentStart';
  }

  if (key === 'End' || (isMac && key === 'ArrowDown')) {
    return 'documentEnd';
  }

  return SHORTCUTS[key];
}

function getPlatform(): string {
  const navigator = globalThis.navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return navigator?.platform ?? navigator?.userAgentData?.platform ?? 'unknown';
}
