export const spriteConfig = {
  icons: [
    'IconArrow',
    'IconArrowRightShort',
    'IconBrandGithub',
    'IconChevronsNarrow',
    'IconChevron',
    'IconDiffSplit',
    'IconDiffUnified',
    'IconExpand',
    'IconExpandAll',
    'IconFileCode',
    'IconPlus',
    'IconRegex',
    'IconSearch',
    'IconSymbolDiffstat',
    'IconSymbolAdded',
    'IconSymbolDeleted',
    'IconSymbolIgnored',
    'IconSymbolModified',
    'IconSymbolMoved',
    'IconSymbolRef',
    'IconType',
    'IconTypeWord',
    'IconX',
  ],

  output: {
    file: 'packages/diffs/src/sprite.ts',
    symbolPrefix: 'diffs-icon-',
  },

  source: {
    extension: '.svg',
  },
};
