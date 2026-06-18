import { describe, expect, test } from 'bun:test';

import {
  type MatchRange,
  SearchPanelWidget,
  type SearchParams,
} from '../src/editor/searchPanel';
import { installDom } from './domHarness';

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createContainer(): HTMLElement {
  const container = document.createElement('pre');
  document.body.appendChild(container);
  return container;
}

function getSearchPanelRoot(): ShadowRoot {
  const host = document.querySelector<HTMLElement>('[data-search-panel]');
  if (host?.shadowRoot === undefined || host.shadowRoot === null) {
    throw new Error('Expected search panel shadow root');
  }
  return host.shadowRoot;
}

function searchParams(overrides: Partial<SearchParams>): SearchParams {
  return {
    text: '',
    replaceText: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    ...overrides,
  };
}

describe('SearchPanelWidget', () => {
  test('runs in find-only mode without replace handlers', async () => {
    const dom = installDom();
    try {
      const searchCalls: SearchParams[] = [];
      const updates: MatchRange[][] = [];

      const widget = new SearchPanelWidget<MatchRange>({
        containerElement: createContainer(),
        defaultQuery: 'foo',
        mode: 'replace',
        initialMatch: [0, 3],
        search: (params) => {
          searchCalls.push(params);
          return [[0, 3]];
        },
        scrollToMatch: () => {},
        onUpdate: (matches) => {
          updates.push(matches);
          return matches[0];
        },
        onClose: () => {},
      });

      await waitForAnimationFrame();

      const panel = getSearchPanelRoot();
      const grid = panel?.querySelector<HTMLElement>('[data-search-grid]');

      expect(searchCalls).toEqual([searchParams({ text: 'foo' })]);
      expect(updates).toEqual([[[0, 3]]]);
      expect(grid?.dataset.mode).toBe('find');
      expect(panel?.querySelector('[data-replace]')).toBeNull();
      expect(
        panel.querySelector('#diffs-editor-icon-arrow-down')
      ).not.toBeNull();

      widget.setMode('replace');
      expect(grid?.dataset.mode).toBe('find');

      widget.cleanup();
    } finally {
      dom.cleanup();
    }
  });

  test('delegates replace actions to optional replace handlers', async () => {
    const dom = installDom();
    try {
      const matches: MatchRange[] = [
        [0, 3],
        [4, 7],
      ];
      const replacedMatches: [MatchRange, SearchParams][] = [];
      const scrolledMatches: [MatchRange, boolean][] = [];
      const replaceAllCalls: [MatchRange[], SearchParams][] = [];

      const widget = new SearchPanelWidget<MatchRange>({
        containerElement: createContainer(),
        defaultQuery: 'foo',
        mode: 'replace',
        initialMatch: matches[0],
        search: () => matches,
        isSameMatch: ([aStart, aEnd], [bStart, bEnd]) =>
          aStart === bStart && aEnd === bEnd,
        scrollToMatch: (match, retainFocus) => {
          scrolledMatches.push([match, retainFocus]);
        },
        replace: {
          replaceMatch: (match, params) => {
            replacedMatches.push([match, params]);
            return [11, 11];
          },
          replaceAll: (allMatches, params) => {
            replaceAllCalls.push([allMatches, params]);
          },
        },
        onUpdate: (allMatches) => allMatches[0],
        onClose: () => {},
      });

      await waitForAnimationFrame();

      const panel = getSearchPanelRoot();
      const replaceInput = panel.querySelector<HTMLInputElement>(
        'input[data-replace]'
      )!;
      replaceInput.value = 'bar';
      replaceInput.dispatchEvent(new Event('input', { bubbles: true }));

      panel.querySelector<HTMLElement>('[data-icon="replace"]')!.click();
      panel.querySelector<HTMLElement>('[data-icon="replace-all"]')!.click();

      expect(replacedMatches).toEqual([
        [matches[0], searchParams({ text: 'foo', replaceText: 'bar' })],
      ]);
      expect(scrolledMatches).toContainEqual([[11, 11], true]);
      expect(replaceAllCalls).toEqual([
        [matches, searchParams({ text: 'foo', replaceText: 'bar' })],
      ]);

      widget.cleanup();
    } finally {
      dom.cleanup();
    }
  });
});
