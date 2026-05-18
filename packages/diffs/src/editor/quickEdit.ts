import { h } from './utils';

export class QuickEdit {
  #gutter: HTMLElement;
  #content: HTMLElement;
  #slot: HTMLElement;
  #observer: ResizeObserver;
  #onResize: () => void;

  constructor(
    public line: number,
    quickEditElement: HTMLElement,
    fileContainer: HTMLElement,
    leadingWhitespaces = 0,
    onResize: () => void
  ) {
    const slotName = 'quick-edit-' + line;
    this.#slot = h(
      'div',
      {
        dataset: 'quickEditSlot',
        slot: slotName,
        style: 'white-space: normal',
        children: [quickEditElement],
      },
      fileContainer
    );
    this.#gutter = h('div', {
      dataset: { gutterBuffer: 'quickEdit', bufferSize: '1' },
      style: 'grid-row: span 1',
    });
    this.#content = h('div', {
      dataset: { quickEdit: String(line) },
      style: {
        paddingInlineStart: leadingWhitespaces + 1 + 'ch', // +1 align css `padding-inline`
      },
      contentEditable: 'false',
      children: [h('slot', { name: slotName })],
    });
    this.#observer = new ResizeObserver(onResize);
    this.#observer.observe(this.#slot);
    this.#onResize = onResize;
  }

  render(contentElement: HTMLElement): void {
    const gutterElement = contentElement?.previousElementSibling;
    const gutterLineElement = gutterElement?.querySelector<HTMLElement>(
      `[data-column-number][data-line-index="${this.line}"]`
    );
    const contentLineElement = contentElement.querySelector<HTMLElement>(
      `[data-line][data-line-index="${this.line}"]`
    );
    if (
      gutterElement != null &&
      gutterLineElement != null &&
      contentLineElement != null
    ) {
      gutterLineElement.before(this.#gutter);
      contentLineElement.before(this.#content);
      this.#onResize();
    }
  }

  cleanup(): void {
    this.#gutter.remove();
    this.#content.remove();
    this.#slot.remove();
    this.#observer.disconnect();
  }
}
