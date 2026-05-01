import type { TextDocumentChange } from './textDocument';

export function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  props: {
    id?: string;
    class?: string;
    style?: Partial<CSSStyleDeclaration>;
    dataset?: DOMStringMap | string[] | string;
    textContent?: string;
  } = {},
  parent?: Element | ShadowRoot
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tagName);
  const { id, class: className, style, dataset, textContent } = props;
  if (id) {
    el.id = id;
  }
  if (className !== undefined) {
    el.className = className;
  }
  if (style !== undefined) {
    Object.assign(el.style, style);
  }
  if (dataset !== undefined) {
    if (typeof dataset === 'string') {
      el.dataset[dataset] = '';
    } else if (Array.isArray(dataset)) {
      dataset.forEach((key) => {
        el.dataset[key] = '';
      });
    } else {
      Object.assign(el.dataset, dataset);
    }
  }
  if (textContent !== undefined) {
    el.textContent = textContent;
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
  el: HTMLElement | Document | ShadowRoot | Window,
  event: string,
  listener: EventListener
) {
  el.addEventListener(event, listener);
  return () => {
    el.removeEventListener(event, listener);
  };
}

export function isCodeLineTarget(target?: EventTarget): target is HTMLElement {
  if (target === undefined || !(target instanceof HTMLElement)) {
    return false;
  }
  return (
    (target.tagName === 'DIV' && target.dataset.line !== undefined) ||
    (target.tagName === 'SPAN' && target.dataset.char !== undefined)
  );
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
  return ' '.repeat(tabSize);
}

export function resolveDirtyLines(
  change: TextDocumentChange | undefined,
  startingLine: number,
  endLine: number
): {
  dirtyLines: Set<number>;
  dirtyLineStart: number;
  dirtyLineEnd: number;
  tokenizerStartLine: number;
} {
  const dirtyLines = new Set<number>();
  if (endLine <= startingLine) {
    return {
      dirtyLines,
      dirtyLineStart: -1,
      dirtyLineEnd: -1,
      tokenizerStartLine: startingLine,
    };
  }

  if (change === undefined) {
    for (let line = startingLine; line < endLine; line++) {
      dirtyLines.add(line);
    }
    return {
      dirtyLines,
      dirtyLineStart: startingLine,
      dirtyLineEnd: endLine - 1,
      tokenizerStartLine: startingLine,
    };
  }

  const tokenizerStartLine = Math.max(0, change.startLine);
  if (change.startLine >= endLine) {
    return {
      dirtyLines,
      dirtyLineStart: -1,
      dirtyLineEnd: -1,
      tokenizerStartLine,
    };
  }

  let dirtyLineStart = Math.max(change.startLine, startingLine);
  let dirtyLineEnd = Math.min(change.endLine, endLine - 1);
  let shouldMarkDirtyLines = true;

  if (change.lineDelta !== 0) {
    dirtyLineEnd = endLine - 1;
  } else if (change.endLine < startingLine) {
    // No visible line text changed, but a tokenizer state change may flow in.
    dirtyLineStart = startingLine;
    dirtyLineEnd = startingLine;
    shouldMarkDirtyLines = false;
  }

  if (dirtyLineEnd < dirtyLineStart) {
    dirtyLineEnd = dirtyLineStart;
  }

  if (shouldMarkDirtyLines) {
    for (let line = dirtyLineStart; line <= dirtyLineEnd; line++) {
      dirtyLines.add(line);
    }
  }

  return {
    dirtyLines,
    dirtyLineStart,
    dirtyLineEnd,
    tokenizerStartLine,
  };
}

export function extend<T extends object>(obj: T, attrs: Partial<T>): T {
  return Object.assign(obj, attrs);
}
