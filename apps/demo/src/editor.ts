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
const editor = new Editor<undefined>();
const virtualizer = new Virtualizer();
const poolManager = createWorkerAPI({
  theme: DEFAULT_THEMES,
  langs: ['typescript', 'tsx'],
  preferredHighlighter: 'shiki-wasm',
  useTokenTransformer: true,
});
const fileInstance = new VirtualizedFile<undefined>(
  {},
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

function onFileChange(file: FileContents) {
  const gs = gitStatus.filter((e) => e.path !== file.name);
  gs.push({ path: file.name, status: 'modified' });
  fileTree.setGitStatus(gs);
  console.log('writeFile', file.name);
}

void poolManager.initialize().then(() => {
  console.log('WorkerPoolManager initialized, with:', poolManager.getStats());
});
virtualizer.setup(editorContainer);
fileTree.setSearch('editor');
fileTree.render({ fileTreeContainer });
editor.edit(fileInstance, (file) => void onFileChange(file));
