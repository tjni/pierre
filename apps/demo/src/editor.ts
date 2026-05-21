import {
  DEFAULT_THEMES,
  type FileContents,
  VirtualizedFile,
  Virtualizer,
} from '@pierre/diffs';
import { Editor } from '@pierre/diffs/editor';
import { FileTree, type GitStatusEntry } from '@pierre/trees';

import { createWorkerAPI } from './utils/createWorkerAPI';
import './style.css';

const API = {
  // get git status
  getGitStatus: () => {
    return fetch(`/git-status/packages/diffs`).then(
      (res) => res.json() as unknown as GitStatusEntry[]
    );
  },

  // get paths
  getPaths: () => {
    return fetch('/fs/packages/diffs').then(
      (res) => res.json() as unknown as string[]
    );
  },

  // read file from disk
  readFile: (path: string) => {
    return fetch(`/fs/packages/diffs/${path}`).then((res) => res.text());
  },
};

const fileTreeContainer = document.getElementById('file-tree-container')!;
const editorContainer = document.getElementById('editor-container')!;
const editor = new Editor<undefined>({
  enabledQuickEdit: true,
  renderQuickEdit: ({ close, replaceSelectionText }) => {
    const el = document.createElement('div');
    const input = document.createElement('input');
    const span = document.createElement('span');
    const left = document.createElement('div');
    const right = document.createElement('div');
    el.className = 'quick-edit';
    input.className = 'quick-edit-input';
    span.className = 'quick-edit-status';
    left.className = 'quick-edit-left';
    right.className = 'quick-edit-right';
    right.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20">
        <line x1="10" y1="14" x2="10" y2="6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></line>
        <polyline points="13 9 10 6 7 9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></polyline>
        <path d="m17,13v1c0,1.657-1.343,3-3,3h-1" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>
        <path d="m13,3h1c1.657,0,3,1.343,3,3v1" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path><path d="m3,7v-1c0-1.657,1.343-3,3-3h1" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>
        <path d="m7,17h-1c-1.657,0-3-1.343-3-3v-1" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>
      </svg>
    `;
    input.placeholder = 'Ask AI...';
    span.textContent = 'Thinking...';
    input.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.style.opacity = '0';
        span.style.opacity = '1';
        right.style.opacity = '0.5';
        setTimeout(() => {
          close();
          replaceSelectionText('');
        }, 2000);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    left.append(span, input);
    el.append(left, right);
    setTimeout(() => {
      input.focus();
    }, 100);
    return el;
  },
  onChange: (file) => {
    const gs = gitStatus.filter((e) => e.path !== file.name);
    gs.push({ path: file.name, status: 'modified' });
    fileTree.setGitStatus(gs);
    console.log('writeFile', file.name);
  },
});
const virtualizer = new Virtualizer();
const poolManager = createWorkerAPI({
  theme: DEFAULT_THEMES,
  langs: ['typescript', 'tsx'],
  preferredHighlighter: 'shiki-wasm',
  useTokenTransformer: true,
});
const fileInstance = new VirtualizedFile<undefined>(
  {
    stickyHeader: true,
    renderCustomHeader: (file) => {
      const el = document.createElement('div');
      el.className = 'editor-tab';
      const parts = file.name.split('/');
      const filename = parts.at(-1) ?? file.name;
      const dir = parts.slice(0, -1).join('/');
      el.innerHTML = `${dir.length > 0 ? `<span class="editor-tab-dir">${dir}/</span>` : ''}<span class="editor-tab-name">${filename}</span>`;
      return el;
    },
  },
  virtualizer,
  undefined,
  poolManager
);
const [paths, gitStatus] = await Promise.all([
  API.getPaths(),
  API.getGitStatus(),
]);
const fileTree = new FileTree({
  paths,
  gitStatus,
  density: 'compact',
  search: true,
  searchBlurBehavior: 'retain',
  onSelectionChange: (selectedPaths) => {
    if (selectedPaths.length === 1) {
      const filename = selectedPaths[0];
      if (!filename.endsWith('/')) {
        void openDocument(filename);
      }
    }
  },
});

async function openDocument(filename: string) {
  const file: FileContents = {
    name: filename,
    contents: await API.readFile(filename),
  };
  fileInstance.render({
    file,
    containerWrapper: editorContainer,
  });
  editorContainer.scrollTo({ left: 0, top: 0 });
}

void poolManager.initialize().then(() => {
  console.log('WorkerPoolManager initialized, with:', poolManager.getStats());
});
virtualizer.setup(editorContainer);
fileTree.setSearch('editor');
fileTree.render({ fileTreeContainer });
editor.edit(fileInstance);

const splash = document.getElementById('splash');
if (splash !== null) {
  splash.classList.add('hidden');
  splash.addEventListener('transitionend', () => splash.remove(), {
    once: true,
  });
}
