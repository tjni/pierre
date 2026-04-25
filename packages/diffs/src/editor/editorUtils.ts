export function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  props?: {
    id?: string;
    class?: string;
    style?: Record<string, string | undefined>;
  },
  parent?: Element
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tagName);
  if (props?.class) {
    el.className = props.class;
  }
  if (props?.style !== undefined) {
    Object.assign(el.style, props.style);
  }
  if (props?.id) {
    el.id = props.id;
  }
  if (parent !== undefined) {
    parent.appendChild(el);
  }
  return el;
}

export function addEventListener<K extends keyof HTMLElementEventMap>(
  el: HTMLElement,
  event: K,
  listener: (this: HTMLElement, evt: HTMLElementEventMap[K]) => void
): () => void;
export function addEventListener<K extends keyof DocumentEventMap>(
  el: Document,
  event: K,
  listener: (this: Document, evt: DocumentEventMap[K]) => void
): () => void;
export function addEventListener<K extends keyof WindowEventMap>(
  el: Window,
  event: K,
  listener: (this: Window, evt: WindowEventMap[K]) => void
): () => void;
export function addEventListener(
  el: HTMLElement | Document | Window,
  event: string,
  listener: EventListener
) {
  el.addEventListener(event, listener);
  return () => {
    el.removeEventListener(event, listener);
  };
}

export function getRootCssVariableValue(
  variableName: string
): string | undefined {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(variableName)
    .trim();
  return value !== '' ? value : undefined;
}

export function parseCssValue(value: string): [value: number, unit: string] {
  const parsedValue = Number.parseFloat(value);
  if (!Number.isFinite(parsedValue)) {
    return [0, ''];
  }
  let unitStartIndex = -1;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      code !== /*.*/ 46 &&
      (code < /*0*/ 48 || code > /*9*/ 57) &&
      i !== 0 &&
      i !== value.length - 1
    ) {
      unitStartIndex = i;
      break;
    }
  }
  return [parsedValue, unitStartIndex > 0 ? value.slice(unitStartIndex) : ''];
}

export function coalesceMicrotask(run: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) {
      return;
    }
    queued = true;
    queueMicrotask(() => {
      queued = false;
      run();
    });
  };
}

export function measureMonoFontWidth(font: string): number {
  const canvas = createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('measureMonoFontWidth: Failed to get canvas context');
  }
  context.font = font;
  const width = context.measureText('0').width;
  for (let i = 1; i < 16; i++) {
    const w = context.measureText(i.toString(16)).width;
    if (w !== width) {
      throw new Error(`The font "${font}" isn't a monospace font`);
    }
  }
  return width;
}

export function getLineIndentation(lineText: string): string {
  let indentation = '';
  for (let i = 0; i < lineText.length; i++) {
    const char = lineText[i];
    if (char === ' ' || char === '\t') {
      indentation += char;
    } else {
      break;
    }
  }
  return indentation;
}

export function getLineIndentationUnit(
  lineText: string,
  tabSize: number
): string {
  if (lineText.startsWith('\t')) {
    return '\t';
  }
  if (lineText.startsWith(' ')) {
    return ' '.repeat(Math.max(1, Math.min(tabSize, lineText.length)));
  }
  return ' '.repeat(tabSize);
}

export function extend<T extends object>(obj: T, attrs: Partial<T>): T {
  return Object.assign(obj, attrs);
}
