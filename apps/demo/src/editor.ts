import {
  Editor,
  type FileContents,
  VirtualizedFile,
  Virtualizer,
} from '@pierre/diffs';
import { FileTree } from '@pierre/trees';

import './style.css';

const API = {
  paths: () =>
    fetch('/fs/packages/diffs').then(
      (res) => res.json() as unknown as string[]
    ),
  renderFile: (path: string) =>
    fetch(`/fs/packages/diffs/${path}`).then((res) => res.text()),
  writeFile: (path: string, contents: string) =>
    fetch(`/fs/packages/diffs/${path}`, { method: 'POST', body: contents }),
};

const fileTreeContainer = document.getElementById('file-tree-container')!;
const editorContainer = document.getElementById('editor-container')!;
const editor = new Editor<undefined>();
const virtualizer = new Virtualizer();
const fileInstance = new VirtualizedFile<undefined>({}, virtualizer);
const fileTree = new FileTree({
  paths: await API.paths(),
  search: true,
  onSelectionChange: (selectedPaths) => {
    if (selectedPaths.length === 1) {
      const filename = selectedPaths[0];
      if (!filename.endsWith('/')) {
        void openDocument(filename);
      }
    }
  },
  unsafeCSS: /* CSS */ `
    :host {
      --trees-bg-override: transparent;
    }
  `,
});

async function openDocument(filename: string) {
  const file: FileContents = {
    name: filename,
    contents: await API.renderFile(filename),
  };
  editorContainer.scrollTo({ left: 0, top: 0 });
  fileInstance.render({
    file,
    containerWrapper: editorContainer,
  });
}

virtualizer.setup(editorContainer);
editor.edit(fileInstance, (file) => {
  console.log('edit', file);
});
fileTree.render({ fileTreeContainer });
