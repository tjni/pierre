export const TOKENIZE_TIME_LIMIT = 500;
export const TOKENIZE_MAX_LINE_LENGTH = 1000;
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
  [data-line] {
    background-color: transparent;
    cursor: text;
  }
  [data-gutter], [data-line-annotation] {
    user-select: none;
  }
  [data-content] {
    position: relative;
  }
  [data-textarea], [data-caret], [data-line-highlight], [data-selection-range] {
    position: absolute;
    top: 0;
    left: 0;
    z-index: -10;
    height: 1lh;
    line-height: var(--diffs-line-height);
    pointer-events: none;
  }
  [data-textarea] {
    font: inherit;
    padding: 0;
    padding-inline: 1ch;
    color: transparent;
    color: transparent;
    background-color: transparent;
    border: none;
    outline: none;
    resize: none;
    overflow: hidden;
    field-sizing: content;
  }
  [data-overflow='scroll'] [data-textarea] {
    white-space: pre;
    min-height: 1lh;
  }
  [data-overflow='wrap'] [data-textarea] {
    white-space: pre-wrap;
    word-break: break-word;
  }
  [data-caret] {
    width: 2px;
    background-color: var(--diffs-bg-caret);
    animation: blinking 1.2s infinite;
    animation-delay: 0.6s;
    visibility: hidden;
    z-index: 0;
  }
  [data-textarea][data-state='focus'] ~ [data-caret] {
    visibility: visible;
  }
  [data-line-highlight] {
    width: 100%;
    background-color: var(--diffs-bg-selection);
  }
  [data-selection-range] {
    background-color: var(--diffs-bg-selection);
  }
`;
