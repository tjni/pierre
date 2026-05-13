import {
  DEFAULT_THEMES,
  Editor,
  type FileContents,
  VirtualizedFile,
  Virtualizer,
} from '@pierre/diffs';
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

  // write file to disk
  writeFile: (path: string, contents: string) => {
    return fetch(`/fs/packages/diffs/${path}`, {
      method: 'POST',
      body: contents,
    });
  },
};

const recentFile = localStorage.getItem('diffs-editor:recentFile');
const fileTreeContainer = document.getElementById('file-tree-container')!;
const editorContainer = document.getElementById('editor-container')!;
const editor = new Editor<undefined>();
const virtualizer = new Virtualizer();
const poolManager = (() => {
  const manager = createWorkerAPI({
    theme: DEFAULT_THEMES,
    langs: ['typescript', 'tsx'],
    preferredHighlighter: 'shiki-wasm',
    useTokenTransformer: true,
  });
  void manager.initialize().then(() => {
    console.log('WorkerPoolManager initialized, with:', manager.getStats());
  });

  // @ts-expect-error bcuz
  window.__POOL = manager;
  return manager;
})();
const fileInstance = new VirtualizedFile<undefined>(
  {
    unsafeCSS: /* CSS */ `
      [data-diffs-header] {
        position: sticky;
        top: 0;
        z-index: 100;
      }
    `,
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
  search: true,
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
  localStorage.setItem('diffs-editor:recentFile', filename);
}

function onFileChange(file: FileContents) {
  console.log('writeFile', file.name);
  // await API.writeFile(file.name, file.contents);
  // fileTree.setGitStatus(await API.getGitStatus());
}

virtualizer.setup(editorContainer, editorContainer);
fileTree.render({ fileTreeContainer });
editor.edit(fileInstance, (file) => void onFileChange(file));

if (recentFile !== null && paths.includes(recentFile)) {
  fileTree.focusPath(recentFile);
  void openDocument(recentFile);
}
