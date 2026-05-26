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

  @media (width >= 480px) {
    [data-content] {
      caret-color: ${DEBUG_SELECTION ? 'red' : 'transparent'};
    }
    [data-quick-edit] {
      caret-color: currentColor;
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
    background-color: ${DEBUG_SELECTION ? 'transparent' : 'var(--diffs-bg-caret)'};
    animation: blinking 1.2s infinite;
    animation-delay: 0.8s;
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

  @media (width >= 480px) {
    [data-content]:focus ~ [data-editor-overlay] [data-caret] {
      visibility: visible;
    }
  }

  [data-quick-edit-icon] {
    position: absolute;
    top: 0;
    left: calc(-1lh + 2px);
    z-index: 10;
    width: 1lh;
    height: 1lh;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: color-mix(in lab, var(--diffs-fg) 40%, var(--diffs-bg));
    transition: background-color 0.1s ease-in-out, color 0.1s ease-in-out;
    cursor: pointer;
    visibility: hidden;
  }
  [data-quick-edit-icon][data-visible='true'] {
    visibility: visible;
  }
  [data-quick-edit-icon]:hover {
    background-color: color-mix(in lab, var(--diffs-fg) 8%, var(--diffs-bg));
    color: var(--diffs-fg);
  }
  [data-quick-edit] {
    padding-inline-end: 1ch;
  }

  [data-search-panel] {
    --editor-panel-shadow-color: light-dark(rgb(0 0 0 / 0.075), rgb(0 0 0 / 0.15));
    position: fixed;
    top: 12px;
    right: 12px;
    min-width: 300px;
    max-width: 100%;
    margin-inline: 8px;
    z-index: 100;
    display: flex;
    gap: 4px;
    margin-inline: 1ch;
    margin-bottom: 4px;
    background-clip: padding-box;
    background-color: color-mix(in lab, color-mix(in lab, var(--diffs-fg) 4%, var(--diffs-bg)), transparent 40%);
    border: 1px solid color-mix(in lab, var(--diffs-fg) 15%, var(--diffs-bg));
    padding: 6px 6px 6px 10px;
    border-radius: 8px;
    box-shadow: 0 2px 4px var(--editor-panel-shadow-color), 0 4px 8px var(--editor-panel-shadow-color);
    backdrop-filter: blur(8px);
  }
  [data-search-panel-row] {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 1px;
    width: 100%;
  }
  [data-search-panel-row] input {
    field-sizing: content;
    min-width: 120px;
    font-size: 14px;
    line-height: 24px;
    padding-inline: 4px;
    border: none;
    outline: none;
    background-color: transparent;
    color: var(--diffs-fg);
  }
  [data-search-panel-row] input::selection {
    background-color: color-mix(in lab, var(--diffs-fg) 8%, var(--diffs-bg));
  }
  [data-search-panel-row] [data-matches] {
    min-width: 10ch;
    font-size: 12px;
    line-height: 20px;
    padding-inline: 4px;
    margin-right: auto;
    color: color-mix(in lab, var(--diffs-fg) 50%, var(--diffs-bg));
  }

  [data-search-panel-row] [data-divider] {
    width: 1px;
    height: 12px;
    margin-inline: 8px;
    background-color: color-mix(in lab, var(--diffs-fg) 12%, var(--diffs-bg));
    flex-shrink: 0;
  }
  [data-search-panel-row] svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }
  [data-search-panel-row] [data-icon] {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    display: flex;
    color: color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg));
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.1s ease-in-out, color 0.1s ease-in-out;
  }
  [data-search-panel-row] [data-icon="search"] {
    width: 16px;
    margin-right: 2px;
  }
  [data-search-panel-row] [data-icon][data-disabled='true'] {
    opacity: 0.25;
    pointer-events: none;
  }
  [data-search-panel-row] [data-icon]:not([data-icon='search']):hover {
    background-color: color-mix(in lab, var(--diffs-fg) 6%, var(--diffs-bg));
    color: var(--diffs-fg);
  }
  [data-search-panel-row] [data-icon][data-active='true'] {
    background-color: color-mix(in lab, var(--diffs-fg) 10%, var(--diffs-bg));
    color: var(--diffs-fg);
  }
`;

// Safari doesn't support `::selection` for slot elements in ShadowDOM,
// Add a global style to disable selection for slot elements
export const editorGlobalCSS = /* CSS */ `
  [data-annotation-slot] {
    user-select: none;
    -webkit-user-select: none;
  }
`;
