import { h } from './utils';

export class QuickEdit {
  #gutterBuffer: HTMLElement;
  #quickEditContainer: HTMLElement;
  #slot: HTMLElement;
  #observer: ResizeObserver;
  #handleResize: () => void;

  constructor(
    public line: number,
    quickEditElement: HTMLElement,
    fileContainer: HTMLElement,
    leadingWhitespaces = 0,
    handleResize: () => void
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
    this.#gutterBuffer = h('div', {
      dataset: { gutterBuffer: 'quickEdit', bufferSize: '1' },
      style: 'grid-row: span 1',
    });
    this.#quickEditContainer = h('div', {
      dataset: { quickEdit: String(line) },
      style: {
        paddingInlineStart: leadingWhitespaces + 1 + 'ch', // +1 align css `padding-inline`
      },
      contentEditable: 'false',
      children: [h('slot', { name: slotName })],
    });
    this.#observer = new ResizeObserver(handleResize);
    this.#observer.observe(this.#slot);
    this.#handleResize = handleResize;
  }

  render(contentElement: HTMLElement): void {
    const gutterElement =
      contentElement.previousElementSibling as HTMLElement | null;
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
      gutterLineElement.before(this.#gutterBuffer);
      contentLineElement.before(this.#quickEditContainer);
      gutterElement.style.gridRow = 'span ' + gutterElement.children.length;
      contentElement.style.gridRow = 'span ' + contentElement.children.length;
      this.#handleResize();
    }
  }

  cleanup(): void {
    const gutter = this.#gutterBuffer.parentElement;
    const content = this.#quickEditContainer.parentElement;

    this.#gutterBuffer.remove();
    this.#quickEditContainer.remove();

    if (gutter != null && content != null) {
      gutter.style.gridRow = 'span ' + gutter.children.length;
      content.style.gridRow = 'span ' + content.children.length;
    }

    this.#slot.remove();
    this.#observer.disconnect();
  }
}
