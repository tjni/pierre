export const EDITOR_CSS = /* CSS */ `
  ::selection {
    background-color: transparent;
  }
  @keyframes blinking {
    0% { opacity: 0.9; }
    50% { opacity: 0; }
    100% { opacity: 0.9; }
  }
  [data-line] {
    background-color: transparent;
  }
  [data-line-annotation] {
    user-select: none;
  }
  [data-content] {
    position: relative;
  }
  [data-textarea], [data-caret], [data-line-highlight], [data-selection-range] {
    position: absolute;
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
    transform: translateY(-1lh);
    border: none;
    outline: none;
    resize: none;
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
    background-color: var(--fg);
    animation: blinking 1.2s infinite;
    animation-delay: 0.6s;
  }
  [data-line-highlight] {
    width: 100%;
    background-color: var(--diffs-bg-selection);
  }
  [data-selection-range] {
    background-color: var(--diffs-bg-selection);
  }
`;
