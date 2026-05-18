export function h<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  props: {
    style?: string | Partial<CSSStyleDeclaration>;
    dataset?: DOMStringMap | string[] | string;
    children?: (Node | string)[];
    textContent?: string;
    html?: string;
  } & Partial<
    Omit<
      HTMLElementTagNameMap[K],
      'style' | 'dataset' | 'children' | 'textContent' | 'html'
    >
  > = {},
  parent?: Element | ShadowRoot | DocumentFragment
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tagName);
  const { style, dataset, textContent, html, children, ...attrs } = props;
  Object.assign(el, attrs);
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
  listener: (this: HTMLElement, evt: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions
): () => void;
export function addEventListener<K extends keyof DocumentEventMap>(
  el: Document,
  event: K,
  listener: (this: Document, evt: DocumentEventMap[K]) => void,
  options?: AddEventListenerOptions
): () => void;
export function addEventListener<K extends keyof WindowEventMap>(
  el: Window,
  event: K,
  listener: (this: Window, evt: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions
): () => void;
export function addEventListener(
  el: HTMLElement | Document | ShadowRoot | Window,
  event: string,
  listener: EventListener,
  options?: AddEventListenerOptions
) {
  el.addEventListener(event, listener, options);
  return () => el.removeEventListener(event, listener);
}

export function extend<T extends object>(obj: T, attrs: Partial<T>): T {
  return Object.assign(obj, attrs);
}

// oxlint-disable-next-line typescript/no-explicit-any
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
