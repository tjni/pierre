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
import { createPresortedPreparedInput } from '../_lib/createPresortedPreparedInput';
import { FILE_TREE_PROOF_VIEWPORT_HEIGHT } from '../_lib/workloadMeta';
import { ImperativeFileTreeMount } from './ImperativeFileTreeMount';

const PREVIEW_EXPAND_PATH = 'linux-1/' as const;
const PREVIEW_FOCUS_PATH = 'linux-1/arch/alpha/boot/tools/mkbb.c' as const;
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

interface BulkIngestDemoClientProps {
  mountId: string;
  payloadHtml: string;
  previewPaths: readonly string[];
  totalPathCount: number;
  workloadLabel: string;
  workloadName: string;
}

export function BulkIngestDemoClient({
  mountId,
  payloadHtml,
  previewPaths,
  totalPathCount,
  workloadLabel,
  workloadName,
}: BulkIngestDemoClientProps) {
  const { addLog, log } = useStateLog();
  const treeRef = useRef<FileTree | null>(null);
  const bulkUnsubscribeRef = useRef<(() => void) | null>(null);
  const treeSubscribeRef = useRef<(() => void) | null>(null);
  const [, setBulkInfoRevision] = useState(0);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([]);
  const preparedInput = useMemo(
    () => createPresortedPreparedInput(previewPaths),
    [previewPaths]
  );
  const remainingPathCount = totalPathCount - previewPaths.length;

  const options = useMemo<FileTreeOptions>(() => {
    const source: FileTreeBulkIngestSource = {
      async openSession(signal) {
        addLog(`bulk: loading ${workloadLabel}`);
        const { getVirtualizationWorkload } =
          await import('@pierre/tree-test-data');
        if (signal.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }

        const workload = getVirtualizationWorkload(workloadName);
        const fullPaths = workload.presortedFiles;
        const previewLength = previewPaths.length;
        const previewPrefix = fullPaths.slice(0, previewLength);
        if (
          previewPrefix.length !== previewLength ||
          previewPrefix.some((path, index) => path !== previewPaths[index])
        ) {
          throw new Error(
            `${workloadLabel} preview seed is not a prefix of the selected workload.`
          );
        }

        return {
          chunks: createBulkChunks(fullPaths.slice(previewLength), signal),
          header: { totalPathCount: fullPaths.length },
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
      paths: previewPaths,
      preparedInput,
      renaming: true,
      search: true,
      viewportHeight: FILE_TREE_PROOF_VIEWPORT_HEIGHT,
    };
  }, [addLog, preparedInput, previewPaths, workloadLabel, workloadName]);

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
        description={`This demo starts from a ${previewPaths.length.toLocaleString()}-path ${workloadLabel} preview slice and bulk ingests the remaining ${remainingPathCount.toLocaleString()} paths until the tree reaches the full ${totalPathCount.toLocaleString()}-path dataset. Start the ingest, then expand folders, focus rows, select a file, or press F2 to open an inline rename draft while checkpoints continue to publish.`}
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
              runTreeAction(`expand ${PREVIEW_EXPAND_PATH}`, (tree) => {
                getDirectoryHandle(tree, PREVIEW_EXPAND_PATH)?.expand();
              });
            }}
          >
            Expand {PREVIEW_EXPAND_PATH}
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
            Focus {PREVIEW_FOCUS_PATH}
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
            Select {PREVIEW_FOCUS_PATH}
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
