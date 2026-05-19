import type { DiffsEditorSearchParams } from '../types';
import { isPrimaryModifier } from './platform';
import { h } from './utils';

export class SearchPanel {
  #container: HTMLDivElement;
  #inputElement: HTMLInputElement;
  #matchesElement: HTMLDivElement;
  #searchParams: DiffsEditorSearchParams;
  #allMatches: [number, number][] = [];

  constructor(
    preElement: HTMLElement,
    defaultQuery: string,
    initialMatch: [number, number] | undefined,
    search: (
      params: DiffsEditorSearchParams,
      retainFocus?: boolean
    ) => [number, number] | undefined,
    findAll: (params: DiffsEditorSearchParams) => [number, number][],
    onClose: () => void
  ) {
    this.#searchParams = {
      text: defaultQuery,
      replaceText: '',
      caseSensitive: false,
      wholeWord: true,
      regex: false,
      action: 'findNext',
    };

    const close = () => {
      this.cleanup();
      onClose();
    };

    const updateAllMatches = () => {
      this.#allMatches =
        this.#searchParams.text !== ''
          ? findAll({ ...this.#searchParams, action: 'findAll' })
          : [];
      this.#container
        .querySelectorAll<HTMLElement>('[data-disabled]')
        .forEach((element) => {
          element.dataset.disabled = String(this.#allMatches.length === 0);
        });
    };

    this.#inputElement = h('input', {
      type: 'text',
      placeholder: 'Search',
      dataset: 'search',
      value: defaultQuery,
      oninput: (e: Event) => {
        this.#searchParams.text = (e.target as HTMLInputElement).value;
        updateAllMatches();
        this.updateMatches(this.#allMatches, this.#searchParams.text);
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          this.#searchParams.action = 'findNext';
          const match = search(this.#searchParams, true);
          this.updateMatches(this.#allMatches, this.#searchParams.text, match);
        } else if (e.key === 'f' && isPrimaryModifier(e)) {
          // prevent the default browser search panel open behavior
          e.preventDefault();
        }
      },
    });

    this.#matchesElement = h('div', { dataset: 'matches' });

    this.#container = h('div', {
      dataset: 'searchPanel',
      children: [
        h('div', {
          dataset: 'searchPanelRow',
          children: [
            h('div', {
              dataset: { icon: 'search' },
              innerHTML: `<svg width="16" height="16" viewBox="0 0 20 20">
                <line x1="16.5" y1="16.5" x2="12.0355" y2="12.0355" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                <circle cx="8.5" cy="8.5" r="5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></circle>
                </svg>
              `,
            }),
            this.#inputElement,
            this.#matchesElement,
            h('div', {
              dataset: { icon: 'arrow-up', disabled: 'false' },
              title: 'Previous',
              innerHTML: `<svg width="16" height="16" viewBox="0 0 20 20">
                <line x1="10" y1="17" x2="10" y2="3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                <polyline points="15 8 10 3 5 8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></polyline>
                </svg>
              `,
              onclick: () => {
                this.#searchParams.action = 'findPrevious';
                const match = search(this.#searchParams);
                this.updateMatches(
                  this.#allMatches,
                  this.#searchParams.text,
                  match
                );
              },
            }),
            h('div', {
              dataset: { icon: 'arrow-down', disabled: 'false' },
              title: 'Next',
              innerHTML: `<svg width="16" height="16" viewBox="0 0 20 20">
                  <line x1="10" y1="3" x2="10" y2="17" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                  <polyline points="5 12 10 17 15 12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></polyline>
                  </svg>
                `,
              onclick: () => {
                this.#searchParams.action = 'findNext';
                const match = search(this.#searchParams);
                this.updateMatches(
                  this.#allMatches,
                  this.#searchParams.text,
                  match
                );
              },
            }),
            h('div', { dataset: 'spacer' }),
            h('div', {
              dataset: { icon: 'close' },
              title: 'Close',
              innerHTML: `<svg width="16" height="16" viewBox="0 0 20 20">
                <line x1="5" y1="5" x2="15" y2="15" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                <line x1="5" y1="15" x2="15" y2="5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
                </svg>
              `,
              onclick: close,
            }),
          ],
        }),
      ],
    });

    preElement.before(this.#container);

    requestAnimationFrame(() => {
      if (initialMatch !== undefined) {
        updateAllMatches();
        this.updateMatches(
          this.#allMatches,
          this.#searchParams.text,
          initialMatch
        );
      }
      this.#inputElement.select();
    });
  }

  updateMatches(
    allMatches: [number, number][],
    searchText: string,
    currentMatch: [number, number] = allMatches[0]
  ): void {
    if (searchText === '') {
      this.#matchesElement.textContent = '';
      delete this.#matchesElement.dataset.noMatches;
      return;
    }

    if (allMatches.length === 0) {
      this.#matchesElement.textContent = 'No results';
      this.#matchesElement.dataset.noMatches = '';
    } else {
      delete this.#matchesElement.dataset.noMatches;
      const index = allMatches.findIndex(
        (m) => m[0] === currentMatch[0] && m[1] === currentMatch[1]
      );
      this.#matchesElement.textContent =
        index !== -1 ? `${index + 1} of ${allMatches.length}` : 'No results';
    }
  }

  focus(): void {
    this.#inputElement.select();
  }

  cleanup(): void {
    this.#container.remove();
  }
}
