export function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  props: {
    id?: string;
    class?: string;
    style?: string | Partial<CSSStyleDeclaration>;
    dataset?: DOMStringMap | string[] | string;
    children?: (Node | string)[];
    textContent?: string;
    html?: string;
  } = {},
  parent?: Element | ShadowRoot | DocumentFragment
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tagName);
  const {
    id,
    class: className,
    style,
    dataset,
    textContent,
    html,
    children,
  } = props;
  if (id) {
    el.id = id;
  }
  if (className !== undefined) {
    el.className = className;
  }
  if (style !== undefined) {
    if (typeof style === 'string') {
      el.style.cssText = style;
    } else {
      Object.assign(el.style, style);
    }
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
  if (html !== undefined) {
    el.innerHTML = html;
  }
  if (parent !== undefined) {
    parent.appendChild(el);
  }
  if (children !== undefined) {
    el.replaceChildren(...children);
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
  return () => el.removeEventListener(event, listener);
}

export function isCodeLineTarget(target?: EventTarget): target is HTMLElement {
  if (target === undefined || !(target instanceof HTMLElement)) {
    return false;
  }
  const { tagName, dataset } = target;
  return (
    (tagName === 'DIV' && dataset.line !== undefined) ||
    (tagName === 'SPAN' && dataset.char !== undefined)
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

export function extend<T extends object>(obj: T, attrs: Partial<T>): T {
  return Object.assign(obj, attrs);
}

export function debounce<T extends (...args: any[]) => void>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;
  return function (this: ThisType<T>, ...args: Parameters<T>) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

export function round(value: number, precision: number = 1000): number {
  return Math.round(value * precision) / precision;
}
