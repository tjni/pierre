const DEBUG_SELECTION = false;

export const editorCSS: string = /* CSS */ `
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
  }
  [data-editor-overlay] {
    display: contents;
  }
  @media (min-width: 480px) {
    [data-content]:focus ~ [data-editor-overlay] [data-caret] {
      visibility: visible;
    }
  }

  [data-search-panel] {
    position: sticky;
    top: 8px;
    left: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-inline: 16px;
    background-color: color-mix(in lab, color-mix(in lab, var(--diffs-fg) 3%, var(--diffs-bg)), transparent 40%);
    border: 1px solid color-mix(in lab, var(--diffs-fg) 10%, var(--diffs-bg));
    padding: 8px;
    border-radius: 6px;
    box-shadow: 0 0 12px 0 color-mix(in lab, var(--diffs-fg) 10% var(--diffs-bg));
    backdrop-filter: blur(8px);
  }
  [data-search-panel-row] {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 4px;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 14px;
  }
  [data-search-panel-row] input {
    font-size: 14px;
    line-height: 24px;
    max-width: 50%;
    padding-inline: 4px;
    border: none;
    outline: none;
    background-color: transparent;
    color: var(--diffs-fg);
    field-sizing: content;
  }
  [data-search-panel-row] input::selection {
    background-color: color-mix(in lab, var(--diffs-fg) 8%, var(--diffs-bg));
  }
  [data-search-panel-row] [data-icon] {
    width: 24px;
    height: 24px;
    display: flex;
    color: color-mix(in lab, var(--diffs-fg) 50%, var(--diffs-bg));
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.1s ease-in-out, color 0.1s ease-in-out;
  }
  [data-search-panel-row] [data-icon]:is([data-icon='search']) {
    color: color-mix(in lab, var(--diffs-fg) 30%, var(--diffs-bg));
  }
  [data-search-panel-row] [data-icon]:not([data-icon='search']):hover {
    background-color: color-mix(in lab, var(--diffs-fg) 6%, var(--diffs-bg));
    color: var(--diffs-fg);
  }
  [data-search-panel-row] [data-spacer] {
    flex: 1;
  }
`;
