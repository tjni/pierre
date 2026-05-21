import { isPrimaryModifier } from './platform';
import type { Range, TextDocument } from './textDocument';
import { h } from './utils';

export type SearchKind =
  | 'findNext'
  | 'findPrevious'
  | 'findAll'
  | 'replace'
  | 'replaceAll';

export interface SearchParams {
  text: string;
  replaceText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchPanelOptions {
  textDocument: TextDocument<unknown>;
  containerElement: HTMLElement;
  defaultQuery: string;
  initialMatch?: [number, number];
  postSearch: (
    kind: SearchKind,
    match: [number, number],
    retainFocus?: boolean
  ) => void;
  getCurrentSearchRange: () => Range | undefined;
  onClose: () => void;
}

export class SearchPanelWidget {
  #textDocument: TextDocument<unknown>;
  #container: HTMLDivElement;
  #inputElement: HTMLInputElement;
  #matchesElement: HTMLDivElement;
  #searchParams: SearchParams = {
    text: '',
    replaceText: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  };
  #allMatches: [number, number][] = [];

  constructor(options: SearchPanelOptions) {
    const {
      textDocument,
      containerElement,
      defaultQuery,
      initialMatch,
      postSearch,
      getCurrentSearchRange,
      onClose,
    } = options;

    const close = () => {
      this.cleanup();
      onClose();
    };

    const updateSearchParam = <K extends keyof SearchParams>(
      key: K,
      value: SearchParams[K]
    ) => {
      this.#searchParams[key] = value;
      updateAllMatches();
      this.updateMatches();
    };

    const updateAllMatches = () => {
      this.#allMatches =
        this.#searchParams.text !== ''
          ? this.#textDocument.search('findAll', this.#searchParams)
          : [];
      this.#container
        .querySelectorAll<HTMLElement>('[data-disabled]')
        .forEach((element) => {
          element.dataset.disabled = String(this.#allMatches.length === 0);
        });
    };

    const search = (kind: SearchKind, retainFocus?: boolean) => {
      const matches = this.#textDocument.search(
        kind,
        this.#searchParams,
        getCurrentSearchRange()
      );
      if (matches.length === 0) {
        return;
      }
      const firstMatch = matches[0];
      this.updateMatches(firstMatch);
      postSearch(kind, firstMatch, retainFocus);
    };

    // Creates a stateful icon button that toggles a boolean search param on click.
    const makeToggle = (
      iconHref: string,
      title: string,
      key: 'caseSensitive' | 'wholeWord' | 'regex'
    ) => {
      const btn = h('div', {
        dataset: { icon: key, active: 'false' },
        title,
        innerHTML: `<svg width="16" height="16" viewBox="0 0 16 16"><use href="${iconHref}"></use></svg>`,
        onclick: () => {
          const next = !this.#searchParams[key];
          btn.dataset.active = String(next);
          updateSearchParam(key, next);
        },
      });
      return btn;
    };

    const caseSensitiveBtn = makeToggle(
      '#diffs-icon-type',
      'Match Case',
      'caseSensitive'
    );
    const wholeWordBtn = makeToggle(
      '#diffs-icon-type-word',
      'Whole Word',
      'wholeWord'
    );
    const regexBtn = makeToggle('#diffs-icon-regex', 'Regexp', 'regex');

    this.#textDocument = textDocument;
    this.#searchParams.text = defaultQuery;

    this.#inputElement = h('input', {
      type: 'text',
      placeholder: 'Search',
      dataset: 'search',
      value: defaultQuery,
      oninput: (e: Event) => {
        this.#searchParams.text = (e.target as HTMLInputElement).value;
        updateAllMatches();
        this.updateMatches();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          search('findNext', true);
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
              innerHTML: `<svg width="16" height="16" viewBox="0 0 16 16"><use href="#diffs-icon-search"></use></svg>`,
            }),
            this.#inputElement,
            this.#matchesElement,
            caseSensitiveBtn,
            wholeWordBtn,
            regexBtn,
            h('div', { dataset: 'divider' }),
            h('div', {
              dataset: { icon: 'arrow-up', disabled: 'true' },
              title: 'Previous',
              innerHTML: `<svg style="rotate: -90deg" width="16" height="16" viewBox="0 0 16 16"><use href="#diffs-icon-arrow-right-short"></use></svg>`,
              onclick: () => {
                search('findPrevious');
              },
            }),
            h('div', {
              dataset: { icon: 'arrow-down', disabled: 'true' },
              title: 'Next',
              innerHTML: `<svg style="rotate: 90deg" width="16" height="16" viewBox="0 0 16 16"><use href="#diffs-icon-arrow-right-short"></use></svg>`,
              onclick: () => {
                search('findNext');
              },
            }),
            h('div', {
              dataset: { icon: 'close' },
              title: 'Close',
              innerHTML: `<svg width="16" height="16" viewBox="0 0 16 16"><use href="#diffs-icon-x"></use></svg>`,
              onclick: close,
            }),
          ],
        }),
      ],
    });
    containerElement.before(this.#container);

    requestAnimationFrame(() => {
      updateAllMatches();
      this.updateMatches(initialMatch ?? this.#allMatches[0]);
      this.#inputElement.select();
    });
  }

  updateMatches(currentMatch: [number, number] = this.#allMatches[0]): void {
    const allMatches = this.#allMatches;

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
