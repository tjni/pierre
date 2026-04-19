'use client';

import {
  FileTree,
  type FileTreeBulkIngestSource,
  type FileTreeDirectoryHandle,
  type FileTreeOptions,
} from '@pierre/trees';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ExampleCard } from '../_components/ExampleCard';
import { StateLog, useStateLog } from '../_components/StateLog';
import { AOSP_PREVIEW_PATHS, AOSP_TOTAL_PATH_COUNT } from '../_lib/aospPreview';
import { createPresortedPreparedInput } from '../_lib/createPresortedPreparedInput';
import { fetchUpgradePayload } from '../_lib/fetchUpgradePayload';
import {
  AOSP_UPGRADE_DATA_URL,
  FILE_TREE_PROOF_VIEWPORT_HEIGHT,
} from '../_lib/workloadMeta';
import { ImperativeFileTreeMount } from './ImperativeFileTreeMount';

const PREVIEW_FOCUS_PATH = 'art/artd/artd.cc';
const BULK_PREPARED_INPUT = createPresortedPreparedInput(AOSP_PREVIEW_PATHS);
const BULK_CHUNK_SIZE = 40_000;

async function* createBulkChunks(
  paths: readonly string[],
  signal: AbortSignal
): AsyncGenerator<{ paths: readonly string[] }> {
  for (let index = 0; index < paths.length; index += BULK_CHUNK_SIZE) {
    if (signal.aborted) {
      return;
    }
    yield { paths: paths.slice(index, index + BULK_CHUNK_SIZE) };
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function getDirectoryHandle(
  tree: FileTree,
  path: string
): FileTreeDirectoryHandle | null {
  const item = tree.getItem(path);
  if (item == null || !item.isDirectory()) {
    return null;
  }
  return item as FileTreeDirectoryHandle;
}

export function BulkIngestDemoClient({
  mountId,
  payloadHtml,
}: {
  mountId: string;
  payloadHtml: string;
}) {
  const { addLog, log } = useStateLog();
  const treeRef = useRef<FileTree | null>(null);
  const bulkUnsubscribeRef = useRef<(() => void) | null>(null);
  const treeSubscribeRef = useRef<(() => void) | null>(null);
  const [, setBulkInfoRevision] = useState(0);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([]);

  const options = useMemo<FileTreeOptions>(() => {
    const source: FileTreeBulkIngestSource = {
      async openSession(signal) {
        addLog(`bulk: fetching ${AOSP_UPGRADE_DATA_URL}`);
        const payload = await fetchUpgradePayload(
          AOSP_UPGRADE_DATA_URL,
          signal
        );
        const previewLength = AOSP_PREVIEW_PATHS.length;
        const previewPrefix = payload.paths.slice(0, previewLength);
        if (
          previewPrefix.length !== previewLength ||
          previewPrefix.some(
            (path, index) => path !== AOSP_PREVIEW_PATHS[index]
          )
        ) {
          throw new Error(
            'AOSP preview seed is not a prefix of the fetched dataset.'
          );
        }

        return {
          chunks: createBulkChunks(payload.paths.slice(previewLength), signal),
          header: { totalPathCount: payload.paths.length },
        };
      },
    };

    return {
      flattenEmptyDirectories: false,
      id: 'trees-dev-bulk-demo',
      loading: {
        mode: 'bulk',
        policy: {
          checkpointPathCountCeiling: BULK_CHUNK_SIZE,
          checkpointTimeBudgetMs: 0,
        },
        source,
      },
      paths: AOSP_PREVIEW_PATHS,
      preparedInput: BULK_PREPARED_INPUT,
      renaming: true,
      search: true,
      viewportHeight: FILE_TREE_PROOF_VIEWPORT_HEIGHT,
    };
  }, [addLog]);

  const refreshTreeState = useCallback(() => {
    const tree = treeRef.current;
    setFocusedPath(tree?.getFocusedPath() ?? null);
    setSelectedPaths(tree?.getSelectedPaths() ?? []);
    setBulkInfoRevision((value) => value + 1);
  }, []);

  const handleTreeReady = useCallback(
    (tree: FileTree | null) => {
      bulkUnsubscribeRef.current?.();
      bulkUnsubscribeRef.current = null;
      treeSubscribeRef.current?.();
      treeSubscribeRef.current = null;
      treeRef.current = tree;
      refreshTreeState();
      if (tree == null) {
        return;
      }

      bulkUnsubscribeRef.current = tree.onBulkIngest('*', (event) => {
        addLog(
          `bulk:${event.type} status=${event.info.status} ingested=${event.info.ingestedPathCount}${event.info.totalPathCount == null ? '' : `/${String(event.info.totalPathCount)}`}${event.info.errorMessage == null ? '' : ` error=${event.info.errorMessage}`}`
        );
        refreshTreeState();
      });
      treeSubscribeRef.current = tree.subscribe(() => {
        refreshTreeState();
      });
    },
    [addLog, refreshTreeState]
  );

  useEffect(() => {
    return () => {
      bulkUnsubscribeRef.current?.();
      treeSubscribeRef.current?.();
    };
  }, []);

  const bulkInfo = treeRef.current?.getBulkIngestInfo() ?? null;
  const runTreeAction = useCallback(
    (label: string, action: (tree: FileTree) => void) => {
      const tree = treeRef.current;
      if (tree == null) {
        addLog(`error:${label} tree not ready`);
        return;
      }

      action(tree);
      refreshTreeState();
    },
    [addLog, refreshTreeState]
  );

  return (
    <div className="space-y-6">
      <ExampleCard
        title="Bulk ingest"
        description={`This demo starts from the committed ${AOSP_PREVIEW_PATHS.length.toLocaleString()}-path AOSP preview seed and upgrades into the full ${AOSP_TOTAL_PATH_COUNT.toLocaleString()}-path dataset through the public bulk ingest facade. Start the ingest, then expand folders, focus rows, select a file, or press F2 to open an inline rename draft while checkpoints continue to publish.`}
      >
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            className="rounded-sm border px-2 py-1"
            style={{ borderColor: 'var(--color-border)' }}
            onClick={() => {
              runTreeAction('start bulk ingest', (tree) => {
                tree.startBulkIngest();
              });
            }}
          >
            Start ingest
          </button>
          <button
            type="button"
            className="rounded-sm border px-2 py-1"
            style={{ borderColor: 'var(--color-border)' }}
            onClick={() => {
              runTreeAction('cancel bulk ingest', (tree) => {
                tree.cancelBulkIngest();
              });
            }}
          >
            Cancel ingest
          </button>
          <button
            type="button"
            className="rounded-sm border px-2 py-1"
            style={{ borderColor: 'var(--color-border)' }}
            onClick={() => {
              runTreeAction('expand art', (tree) => {
                getDirectoryHandle(tree, 'art/')?.expand();
              });
            }}
          >
            Expand art/
          </button>
          <button
            type="button"
            className="rounded-sm border px-2 py-1"
            style={{ borderColor: 'var(--color-border)' }}
            onClick={() => {
              runTreeAction('focus preview file', (tree) => {
                tree.focusPath(PREVIEW_FOCUS_PATH);
              });
            }}
          >
            Focus art/artd/artd.cc
          </button>
          <button
            type="button"
            className="rounded-sm border px-2 py-1"
            style={{ borderColor: 'var(--color-border)' }}
            onClick={() => {
              runTreeAction('select preview file', (tree) => {
                const item = tree.getItem(PREVIEW_FOCUS_PATH);
                item?.select();
              });
            }}
          >
            Select art/artd/artd.cc
          </button>
          <button
            type="button"
            className="rounded-sm border px-2 py-1"
            style={{ borderColor: 'var(--color-border)' }}
            onClick={() => {
              runTreeAction('rename preview file', (tree) => {
                tree.startRenaming(PREVIEW_FOCUS_PATH);
              });
            }}
          >
            Start rename draft
          </button>
        </div>
        <ImperativeFileTreeMount
          height={FILE_TREE_PROOF_VIEWPORT_HEIGHT}
          mountId={mountId}
          mountMode="hydrate"
          onTreeReady={handleTreeReady}
          options={options}
          payloadHtml={payloadHtml}
        />
      </ExampleCard>

      <ExampleCard
        title="Bulk ingest state"
        description="The status and progress numbers come from the public bulk ingest query surface. Focus and selection update from the live model so you can verify state survives checkpoint publications while ingesting."
      >
        <div className="grid gap-3 text-xs md:grid-cols-3">
          <div
            className="rounded-sm border px-3 py-2"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <strong>Status</strong>
            <div className="text-muted-foreground mt-1">
              {bulkInfo == null
                ? 'null'
                : `${bulkInfo.status}${bulkInfo.errorMessage == null ? '' : ` (${bulkInfo.errorMessage})`}`}
            </div>
          </div>
          <div
            className="rounded-sm border px-3 py-2"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <strong>Progress</strong>
            <div className="text-muted-foreground mt-1">
              {bulkInfo == null
                ? 'null'
                : `${bulkInfo.ingestedPathCount.toLocaleString()}${bulkInfo.totalPathCount == null ? '' : ` / ${bulkInfo.totalPathCount.toLocaleString()}`}`}
            </div>
          </div>
          <div
            className="rounded-sm border px-3 py-2"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <strong>Interaction state</strong>
            <div className="text-muted-foreground mt-1">
              focus={focusedPath ?? 'null'}
              <br />
              selection=
              {selectedPaths.length === 0
                ? '[]'
                : `[${selectedPaths.join(', ')}]`}
            </div>
          </div>
        </div>
      </ExampleCard>

      <ExampleCard
        title="Bulk ingest log"
        description="These log entries come from the public bulk ingest event surface plus the client-side source lifecycle. Start, cancel, and retry the ingest to watch status transitions and checkpoint publications."
      >
        <StateLog entries={log} />
      </ExampleCard>
    </div>
  );
}
