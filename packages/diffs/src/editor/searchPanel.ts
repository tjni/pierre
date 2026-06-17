import { type MatchRange, type SearchParams } from '../search';
import { isPrimaryModifier } from './platform';
import { getEditorIconSvg, type SVGSpriteNames } from './sprite';
import { h } from './utils';

export type SearchPanelMode = 'find' | 'replace';

export type { MatchRange, SearchParams } from '../search';

export interface SearchPanelReplaceHandlers<TMatch> {
  replaceMatch: (
    match: TMatch,
    searchParams: SearchParams
  ) => TMatch | undefined;
  replaceAll: (matches: TMatch[], searchParams: SearchParams) => void;
}

export interface SearchPanelOptions<TMatch = MatchRange> {
  containerElement: HTMLElement;
  defaultQuery: string;
  mode?: SearchPanelMode;
  initialMatch?: TMatch;
  search: (searchParams: SearchParams) => TMatch[];
  isSameMatch?: (a: TMatch, b: TMatch) => boolean;
  scrollToMatch: (nextMatch: TMatch, retainFocus: boolean) => void;
  replace?: SearchPanelReplaceHandlers<TMatch>;
  onUpdate: (
    matches: TMatch[],
    options?: { syncSelection?: boolean }
  ) => TMatch | undefined;
  onClose: () => void;
}

export class SearchPanelWidget<TMatch = MatchRange> {
  #container: HTMLDivElement;
  #inputElement: HTMLInputElement;
  #updateMatches?: (options?: { syncSelection?: boolean }) => void;
  #applyMode?: (mode: SearchPanelMode) => void;

  constructor(options: SearchPanelOptions<TMatch>) {
    const {
      containerElement,
      defaultQuery,
      mode = 'find',
      initialMatch,
      search,
      isSameMatch = Object.is,
      scrollToMatch,
      replace,
      onUpdate,
      onClose,
    } = options;

    const canReplace = replace !== undefined;
    const normalizeMode = (nextMode: SearchPanelMode): SearchPanelMode =>
      canReplace ? nextMode : 'find';

    const searchParams: SearchParams = {
      text: defaultQuery,
      replaceText: '',
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    };

    const matches = {
      all: [] as TMatch[],
      current: undefined as TMatch | undefined,
    };

    const getSearchParamsSnapshot = (): SearchParams => ({ ...searchParams });
    const getMatchIndex = (match: TMatch): number =>
      matches.all.findIndex((candidate) => isSameMatch(candidate, match));

    // Default to the empty-query "no results" state so it shows on open before
    // any search runs.
    const matchResultElement = h('div', {
      dataset: { matches: '', noMatches: '' },
      textContent: 'No results',
    });

    const updateCurrentMatch = (currentMatch: TMatch | undefined) => {
      if (currentMatch === undefined) {
        matchResultElement.textContent = `${matches.all.length} results`;
      } else {
        const index = getMatchIndex(currentMatch);
        matchResultElement.textContent = `${index + 1} of ${matches.all.length}`;
      }
      matches.current = currentMatch;
    };

    const updateMatches = (options?: { syncSelection?: boolean }) => {
      matches.all =
        searchParams.text !== '' ? search(getSearchParamsSnapshot()) : [];
      this.#container
        .querySelectorAll<HTMLElement>('[data-icon][data-disabled]')
        .forEach((element) => {
          element.dataset.disabled = String(matches.all.length === 0);
        });

      if (searchParams.text === '') {
        matchResultElement.textContent = 'No results';
        matchResultElement.dataset.noMatches = '';
        return;
      }

      if (matches.all.length === 0) {
        matchResultElement.textContent = 'No results';
        matchResultElement.dataset.noMatches = '';
        matches.current = undefined;
        onUpdate([]);
        return;
      }

      delete matchResultElement.dataset.noMatches;
      if (options?.syncSelection === false) {
        const currentMatch = onUpdate(matches.all, { syncSelection: false });
        updateCurrentMatch(currentMatch);
        return;
      }

      updateCurrentMatch(onUpdate(matches.all));
    };
    this.#updateMatches = updateMatches;

    const updateSearchParam = <K extends keyof SearchParams>(
      key: K,
      value: SearchParams[K]
    ) => {
      searchParams[key] = value;
      updateMatches();
    };

    const findNextMatch = (
      findPrevious: boolean = false,
      retainFocus: boolean = false
    ) => {
      const allMatches = matches.all;
      let nextMatch: TMatch | undefined = allMatches[0];
      if (allMatches.length > 0) {
        const currentIndex =
          matches.current !== undefined ? getMatchIndex(matches.current) : -1;
        if (findPrevious && currentIndex === -1) {
          nextMatch = allMatches.at(-1);
        } else if (findPrevious) {
          nextMatch = allMatches.at(currentIndex - 1);
          nextMatch ??= allMatches.at(-1);
        } else if (currentIndex === -1) {
          nextMatch = allMatches[0];
        } else {
          nextMatch = allMatches[currentIndex + 1] ?? allMatches[0];
        }
      }
      if (nextMatch !== undefined) {
        updateCurrentMatch(nextMatch);
        scrollToMatch(nextMatch, retainFocus);
      }
      matches.current = nextMatch;
    };

    const replaceCurrentMatch = () => {
      if (
        replace === undefined ||
        searchParams.text === '' ||
        matches.all.length === 0
      ) {
        return;
      }

      let currentMatch = matches.current;
      if (currentMatch === undefined) {
        findNextMatch(false, true);
        currentMatch = matches.current;
        if (currentMatch === undefined) {
          return;
        }
      }

      const nextMatch = replace.replaceMatch(
        currentMatch,
        getSearchParamsSnapshot()
      );

      // Collapse after the replacement so the next search pass advances.
      if (nextMatch !== undefined) {
        scrollToMatch(nextMatch, true);
      }
      matches.current = undefined;
      updateMatches();
    };

    const replaceAllMatches = () => {
      if (
        replace === undefined ||
        searchParams.text === '' ||
        matches.all.length === 0
      ) {
        return;
      }

      replace.replaceAll(matches.all.slice(), getSearchParamsSnapshot());
      matches.current = undefined;
      updateMatches();
    };

    const close = () => {
      this.cleanup();
      onClose();
    };

    // Builds an always-visible icon button that toggles one boolean search
    // option (case/whole-word/regex). The button reflects its on/off state via
    // the `data-active` attribute so the stylesheet can highlight it.
    const makeToggle = (
      icon: SVGSpriteNames,
      title: string,
      key: 'caseSensitive' | 'wholeWord' | 'regex'
    ) => {
      const button = h('div', {
        dataset: { icon, active: String(searchParams[key]) },
        title,
        innerHTML: getEditorIconSvg(icon, 14),
        onclick: () => {
          const next = !searchParams[key];
          button.dataset.active = String(next);
          updateSearchParam(key, next);
        },
      });
      return button;
    };

    const caseSensitiveToggle = makeToggle(
      'case',
      'Match Case',
      'caseSensitive'
    );
    const wholeWordToggle = makeToggle('whole-word', 'Whole Word', 'wholeWord');
    const regexToggle = makeToggle('regex', 'Regexp', 'regex');

    this.#inputElement = h('input', {
      type: 'text',
      placeholder: 'Search',
      dataset: 'search',
      value: defaultQuery,
      oninput: (e: Event) => {
        searchParams.text = (e.target as HTMLInputElement).value;
        matches.current = undefined;
        updateMatches();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          findNextMatch(false, true);
        } else if (
          isPrimaryModifier(e) &&
          (e.key === 'f' || e.code === 'KeyF')
        ) {
          // Prevent the default browser search panel and switch the panel mode
          // in place (cmd+f -> find, cmd+opt+f -> find/replace).
          e.preventDefault();
          applyMode(e.altKey ? 'replace' : 'find');
        }
      },
    });

    // The three search-option toggles are overlaid on the right edge of the
    // find input instead of sitting beside it.
    const searchTogglesElement = h('div', {
      dataset: 'searchToggles',
      children: [caseSensitiveToggle, wholeWordToggle, regexToggle],
    });

    const findInputBox = h('div', {
      dataset: { inputBox: '', find: '' },
      children: [this.#inputElement, searchTogglesElement],
    });

    const navElement = h('div', {
      dataset: 'searchNav',
      children: [
        h('div', {
          dataset: { icon: 'arrow-up', disabled: 'true' },
          title: 'Previous',
          innerHTML: getEditorIconSvg('arrow-up'),
          onclick: () => {
            findNextMatch(true);
          },
        }),
        h('div', {
          dataset: { icon: 'arrow-down', disabled: 'true' },
          title: 'Next',
          innerHTML: getEditorIconSvg('arrow-down'),
          onclick: () => {
            findNextMatch();
          },
        }),
        h('div', {
          dataset: { icon: 'close' },
          title: 'Close',
          innerHTML: getEditorIconSvg('close'),
          onclick: close,
        }),
      ],
    });

    const gridChildren: Node[] = [findInputBox, matchResultElement, navElement];
    if (canReplace) {
      const replaceInputElement = h('input', {
        type: 'text',
        placeholder: 'Replace',
        dataset: 'replace',
        value: '',
        oninput: (e: Event) => {
          searchParams.replaceText = (e.target as HTMLInputElement).value;
        },
      });

      // The replace input and its action buttons are tagged as replace cells so
      // they can be hidden together when the panel is in find-only mode.
      const replaceInputBox = h('div', {
        dataset: { inputBox: '', replace: '', replaceCell: '' },
        children: [replaceInputElement],
      });

      const replaceActionsElement = h('div', {
        dataset: { replaceActions: '', replaceCell: '' },
        children: [
          h('div', {
            dataset: { icon: 'replace' },
            title: 'Replace',
            innerHTML: getEditorIconSvg('replace'),
            onclick: () => {
              replaceCurrentMatch();
            },
          }),
          h('div', {
            dataset: { icon: 'replace-all' },
            title: 'Replace All',
            innerHTML: getEditorIconSvg('replace-all'),
            onclick: () => {
              replaceAllMatches();
            },
          }),
        ],
      });

      gridChildren.push(replaceInputBox, replaceActionsElement);
    }

    // A 2x2 grid of inputs (find/replace) and their trailing content (results
    // text / replace actions), with the find navigation buttons in a third
    // column on the first row. DOM order drives grid auto-placement:
    //   row 1: find input | results text | nav buttons
    //   row 2: replace input | replace actions
    const gridElement = h('div', {
      dataset: { searchGrid: '', mode: normalizeMode(mode) },
      children: gridChildren,
    });

    // Toggles the panel between find and find/replace modes by showing or
    // hiding the replace cells, then returns focus to the find input.
    const applyMode = (next: SearchPanelMode) => {
      gridElement.dataset.mode = normalizeMode(next);
      this.#inputElement.focus();
      this.#inputElement.select();
    };
    this.#applyMode = applyMode;

    this.#container = h('div', {
      dataset: 'searchPanel',
      children: [
        h('div', {
          dataset: 'editorWidget',
          children: [gridElement],
        }),
      ],
    });

    matches.current = initialMatch;
    containerElement.before(this.#container);

    requestAnimationFrame(() => {
      if (initialMatch !== undefined) {
        updateMatches();
      } else {
        onUpdate([]);
      }
      this.#inputElement.select();
    });
  }

  focus(): void {
    this.#inputElement.focus();
  }

  updateMatches(options?: { syncSelection?: boolean }): void {
    this.#updateMatches?.(options);
  }

  setMode(mode: SearchPanelMode): void {
    this.#applyMode?.(mode);
  }

  cleanup(): void {
    this.#container.remove();
  }
}
