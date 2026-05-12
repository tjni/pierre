import {
  Editor,
  type FileContents,
  VirtualizedFile,
  Virtualizer,
} from '@pierre/diffs';
import { FileTree, type GitStatusEntry } from '@pierre/trees';

import './style.css';

const API = {
  // get git status
  getGitStatus: () =>
    fetch(`/git-status/packages/diffs`).then(
      (res) => res.json() as unknown as GitStatusEntry[]
    ),

  // get paths
  getPaths: () =>
    fetch('/fs/packages/diffs').then(
      (res) => res.json() as unknown as string[]
    ),

  // read file from disk
  readFile: (path: string) =>
    fetch(`/fs/packages/diffs/${path}`).then((res) => res.text()),

  // write file to disk
  writeFile: (path: string, contents: string) =>
    fetch(`/fs/packages/diffs/${path}`, { method: 'POST', body: contents }),
};

const fileTreeContainer = document.getElementById('file-tree-container')!;
const editorContainer = document.getElementById('editor-container')!;
const editor = new Editor<undefined>();
const virtualizer = new Virtualizer();
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
  virtualizer
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
}

virtualizer.setup(editorContainer);
editor.edit(fileInstance, (file) => {
  console.log('edit', file);
});
fileTree.render({ fileTreeContainer });
