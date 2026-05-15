export const TOKENIZE_TIME_LIMIT = 100;
export const TOKENIZE_MAX_LINE_LENGTH = 10000;
export const SEARCH_PANEL_GAP = 8;

const DEBUG_SELECTION = false;

export const EDITOR_CSS: string = /* CSS */ `
  ::selection {
    background-color: ${DEBUG_SELECTION ? 'rgba(255, 0, 0, 0.1)' : 'transparent'};
  }
  @keyframes blinking {
    0% { opacity: 1; }
    50% { opacity: 0; }
    100% { opacity: 1; }
  }
  :host, /* for jump anchor */
  [data-code], /* for editor overlay */
  [data-content] /* for wrap line */
  {
    position: relative;
  }
  [data-content] {
    background-color: transparent;
    caret-color: var(--diffs-bg-caret);
    outline: none;
  }
  @media (min-width: 480px) {
    [data-content] {
      caret-color: ${DEBUG_SELECTION ? 'red' : 'transparent'};
    }
  }
  [data-line] {
    cursor: text;
  }
  [data-line]:not([data-selected-line]) {
    background-color: transparent;
  }
  [data-caret], [data-selection-range] {
    position: absolute;
    top: 0;
    left: 0;
    line-height: var(--diffs-line-height);
    pointer-events: none;
  }
  [data-caret] {
    width: 2px;
    height: 1lh;
    background-color: var(--diffs-bg-caret);
    animation: blinking 1.2s infinite;
    animation-delay: 0.6s;
    visibility: hidden;
  }
  [data-selection-range] {
    height: 1lh;
    z-index: -10;
    background-color: var(--diffs-line-bg);
    opacity: 0.5;
  }
  [data-editor-overlay] {
    display: contents;
  }
  @media (min-width: 480px) {
    [data-content]:focus ~ [data-editor-overlay] [data-caret] {
      visibility: visible;
    }
  }
  [data-content]:focus ~ [data-editor-overlay] [data-selection-range] {
    opacity: 1;
  }

  [data-search-panel] {
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: absolute;
    top: 0;
    left: 0;
    background-color: color-mix(in lab, var(--diffs-fg) 3%, var(--diffs-bg));
    border: 1px solid color-mix(in lab, var(--diffs-fg) 10%, var(--diffs-bg));
    padding: 6px;
    border-radius: 6px;
    box-shadow: 0 0 12px 0 color-mix(in lab, var(--diffs-fg) 10% var(--diffs-bg));
    font-family: Arial, Helvetica, sans-serif;
    font-size: 14px;
  }
  [data-search-panel-row] {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 4px;
  }
  [data-search-panel-row] input {
    font-size: 14px;
    line-height: 22px;
    padding: 0 6px;
    border-radius: 4px;
    border: 1px solid color-mix(in lab, var(--diffs-fg) 20%, var(--diffs-bg));
    outline: none;
    background-color: var(--diffs-bg);
    color: var(--diffs-fg);
  }
  [data-search-panel-row] input:focus {
    border: 1px solid color-mix(in lab, var(--diffs-fg) 50%, var(--diffs-bg));
  }
  [data-search-panel-row] [data-icon] {
    width: 22px;
    height: 22px;
    display: flex;
    color: color-mix(in lab, var(--diffs-fg) 60%, var(--diffs-bg));
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    cursor: pointer;
  }
  [data-search-panel-row] [data-icon]:is([data-icon='search']) {
    color: color-mix(in lab, var(--diffs-fg) 30%, var(--diffs-bg));
  }
  [data-search-panel-row] [data-icon]:not([data-icon='search']):hover {
    background-color: color-mix(in lab, var(--diffs-fg) 10%, var(--diffs-bg));
    color: var(--diffs-fg);
  }
`;
