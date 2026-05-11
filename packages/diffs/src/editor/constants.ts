export const TOKENIZE_TIME_LIMIT = 500;
export const TOKENIZE_MAX_LINE_LENGTH = 10000;
export const TOKENIZE_LINES_PRE_TOKENIZE = 50;

export const EDITOR_CSS = /* CSS */ `
  ::selection {
    background-color: transparent;
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
    caret-color: transparent;
    outline: none;
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
    background-color: var(--diffs-bg-selection);
    opacity: 0.5;
  }
  [data-content]:focus ~ [data-caret] {
    visibility: visible;
  }
  [data-content]:focus ~ [data-selection-range] {
    opacity: 1;
  }
`;
