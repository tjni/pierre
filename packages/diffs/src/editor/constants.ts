export const TOKENIZE_TIME_LIMIT = 100;
export const TOKENIZE_MAX_LINE_LENGTH = 10000;
export const BGTOKENIZER_LINES_PRE_TOKENIZE = 50;

const DEBUG_SELECTION = true;

export const EDITOR_CSS: string = /* CSS */ `
  ::selection {
    background-color: ${DEBUG_SELECTION ? 'rgba(255, 0, 0, 0.1)' : 'transparent'};
  }
  @keyframes blinking {
    0% { opacity: 1; }
    50% { opacity: 0; }
    100% { opacity: 1; }
  }
  [data-code],
  [data-content] {
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
`;
