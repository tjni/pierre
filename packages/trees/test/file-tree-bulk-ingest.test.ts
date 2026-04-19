import { describe, expect, test } from 'bun:test';

import {
  type FileTreeBulkIngestSource,
  FileTreeController,
  type FileTreeDirectoryHandle,
} from '../src/index';
import { FILE_TREE_RENAME_VIEW } from '../src/model/FileTreeController';

function createDeferred<TValue>() {
  let resolvePromise!: (value: TValue) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<TValue>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

async function flushAsync(turns: number = 4): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Bun.sleep(0);
  }
}

function getDirectoryHandle(
  controller: FileTreeController,
  path: string
): FileTreeDirectoryHandle {
  const item = controller.getItem(path);
  if (item == null || !item.isDirectory()) {
    throw new Error(`Expected directory handle for ${path}`);
  }
  return item as FileTreeDirectoryHandle;
}

describe('file-tree bulk ingest', () => {
  test('bulk mode reports idle before the first ingest and seeds the path count', () => {
    const source: FileTreeBulkIngestSource = {
      async openSession() {
        return {
          chunks: (async function* () {})(),
          header: {},
        };
      },
    };
    const controller = new FileTreeController({
      flattenEmptyDirectories: false,
      loading: {
        mode: 'bulk',
        source,
      },
      paths: ['preview/a.ts'],
    });

    expect(controller.getBulkIngestInfo()).toEqual({
      ingestedPathCount: 1,
      status: 'idle',
    });

    controller.destroy();
  });

  test('startBulkIngest applies the header before the first chunk and completes through checkpoints', async () => {
    const firstChunk = createDeferred<{ paths: readonly string[] }>();
    const source: FileTreeBulkIngestSource = {
      async openSession() {
        return {
          chunks: (async function* () {
            yield await firstChunk.promise;
          })(),
          header: { totalPathCount: 2 },
        };
      },
    };
    const controller = new FileTreeController({
      flattenEmptyDirectories: false,
      loading: {
        mode: 'bulk',
        policy: { checkpointTimeBudgetMs: 0 },
        source,
      },
    });
    const events: Array<string> = [];
    controller.onBulkIngest('*', (event) => {
      events.push(
        `${event.type}:${event.info.ingestedPathCount}:${String(event.info.totalPathCount)}`
      );
    });

    controller.startBulkIngest();
    await flushAsync();

    expect(controller.getBulkIngestInfo()).toEqual({
      ingestedPathCount: 0,
      status: 'ingesting',
      totalPathCount: 2,
    });

    firstChunk.resolve({ paths: ['a.ts', 'b.ts'] });
    await flushAsync();

    expect(controller.getBulkIngestInfo()).toEqual({
      ingestedPathCount: 2,
      status: 'completed',
      totalPathCount: 2,
    });
    expect(controller.getItem('a.ts')).not.toBeNull();
    expect(events).toEqual([
      'started:0:undefined',
      'progressed:0:2',
      'progressed:2:2',
      'completed:2:2',
    ]);

    controller.destroy();
  });

  test('cancelBulkIngest retains the last published checkpoint and terminal status', async () => {
    const secondChunk = createDeferred<{ paths: readonly string[] }>();
    const source: FileTreeBulkIngestSource = {
      async openSession() {
        return {
          chunks: (async function* () {
            yield { paths: ['a.ts'] };
            yield await secondChunk.promise;
          })(),
          header: { totalPathCount: 2 },
        };
      },
    };
    const controller = new FileTreeController({
      flattenEmptyDirectories: false,
      loading: {
        mode: 'bulk',
        policy: { checkpointTimeBudgetMs: 0 },
        source,
      },
    });

    controller.startBulkIngest();
    await flushAsync();
    controller.cancelBulkIngest();
    await flushAsync();

    expect(controller.getBulkIngestInfo()).toEqual({
      ingestedPathCount: 1,
      status: 'cancelled',
      totalPathCount: 2,
    });
    expect(controller.getItem('a.ts')).not.toBeNull();

    controller.destroy();
  });

  test('a new ingest cancels the old one and supersedes it', async () => {
    let openCount = 0;
    const source: FileTreeBulkIngestSource = {
      async openSession() {
        openCount += 1;
        if (openCount === 1) {
          return {
            chunks: (async function* () {
              await new Promise(() => {});
            })(),
            header: {},
          };
        }

        return {
          chunks: (async function* () {
            yield { paths: ['fresh.ts'] };
          })(),
          header: { totalPathCount: 1 },
        };
      },
    };
    const controller = new FileTreeController({
      flattenEmptyDirectories: false,
      loading: {
        mode: 'bulk',
        policy: { checkpointTimeBudgetMs: 0 },
        source,
      },
    });
    const eventTypes: string[] = [];
    controller.onBulkIngest('*', (event) => {
      eventTypes.push(event.type);
    });

    controller.startBulkIngest();
    await flushAsync();
    controller.startBulkIngest();
    await flushAsync();

    expect(openCount).toBe(2);
    expect(controller.getBulkIngestInfo()).toEqual({
      ingestedPathCount: 1,
      status: 'completed',
      totalPathCount: 1,
    });
    expect(controller.getItem('fresh.ts')).not.toBeNull();
    expect(eventTypes).toContain('cancelled');

    controller.destroy();
  });

  test('failed ingests retain the last published checkpoint and retries restart from the original seed', async () => {
    let openCount = 0;
    const source: FileTreeBulkIngestSource = {
      async openSession() {
        openCount += 1;
        if (openCount === 1) {
          return {
            chunks: (async function* () {
              yield { paths: ['a.ts'] };
              throw new Error('boom');
            })(),
            header: { totalPathCount: 2 },
          };
        }

        return {
          chunks: (async function* () {
            yield { paths: ['b.ts'] };
          })(),
          header: { totalPathCount: 1 },
        };
      },
    };
    const controller = new FileTreeController({
      flattenEmptyDirectories: false,
      loading: {
        mode: 'bulk',
        policy: { checkpointTimeBudgetMs: 0 },
        source,
      },
    });

    controller.startBulkIngest();
    await flushAsync();
    expect(controller.getBulkIngestInfo()).toEqual({
      errorMessage: 'boom',
      ingestedPathCount: 1,
      status: 'failed',
      totalPathCount: 2,
    });
    expect(controller.getItem('a.ts')).not.toBeNull();

    controller.startBulkIngest();
    await flushAsync();

    expect(controller.getBulkIngestInfo()).toEqual({
      ingestedPathCount: 1,
      status: 'completed',
      totalPathCount: 1,
    });
    expect(controller.getItem('a.ts')).toBeNull();
    expect(controller.getItem('b.ts')).not.toBeNull();

    controller.destroy();
  });

  test('checkpoint publication preserves expansion focus selection and rename draft when paths survive', async () => {
    const source: FileTreeBulkIngestSource = {
      async openSession() {
        return {
          chunks: (async function* () {
            yield { paths: ['src/b.ts'] };
          })(),
          header: { totalPathCount: 2 },
        };
      },
    };
    const controller = new FileTreeController({
      flattenEmptyDirectories: false,
      initialExpansion: 'closed',
      loading: {
        mode: 'bulk',
        policy: { checkpointTimeBudgetMs: 0 },
        source,
      },
      renaming: true,
      paths: ['src/a.ts'],
    });
    const renameView = controller[FILE_TREE_RENAME_VIEW]();

    getDirectoryHandle(controller, 'src/').expand();
    controller.focusPath('src/a.ts');
    controller.selectOnlyPath('src/a.ts');
    expect(controller.startRenaming('src/a.ts')).toBe(true);
    renameView.setValue('draft.ts');

    controller.startBulkIngest();
    await flushAsync();

    expect(getDirectoryHandle(controller, 'src/').isExpanded()).toBe(true);
    expect(controller.getFocusedPath()).toBe('src/a.ts');
    expect(controller.getSelectedPaths()).toEqual(['src/a.ts']);
    expect(renameView.getPath()).toBe('src/a.ts');
    expect(renameView.getValue()).toBe('draft.ts');
    expect(controller.getItem('src/b.ts')).not.toBeNull();

    controller.destroy();
  });
});
