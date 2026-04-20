import { PathStore } from '@pierre/path-store';
import type {
  PathStoreVisibleRow,
  PathStoreVisibleTreeProjectionData,
} from '@pierre/path-store';

import {
  BULK_EXPERIMENT_CHUNK_SIZE,
  BULK_EXPERIMENT_HEAD_START_TAIL_CHUNK_COUNT,
  getBulkExperimentExpansionOptions,
} from './bulkExperimentMeta';
import type {
  BulkExperimentChunkMilestone,
  BulkExperimentInitOptions,
  BulkExperimentRunMetrics,
  BulkExperimentSnapshot,
  BulkExperimentUnresolvedFrontier,
  BulkExperimentVisibleRow,
} from './bulkExperimentProtocol';
import {
  fetchUpgradePayloadWithTimings,
  type UpgradePayloadTimings,
} from './fetchUpgradePayload';

type ProjectionIndexBuffer = Int32Array;
type SnapshotListener = (snapshot: BulkExperimentSnapshot) => void;
type EstimateStrategy = 'exact-final' | 'minimal-frontier';

interface BulkExperimentVisibleProjection {
  getParentIndex(index: number): number;
  paths: readonly string[];
  posInSetByIndex: ProjectionIndexBuffer;
  setSizeByIndex: ProjectionIndexBuffer;
  visibleIndexByPath: Map<string, number>;
}

interface PendingVisibleNode {
  level: number;
  parentPath: string | null;
  path: string;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createVisibleProjection(
  projection: PathStoreVisibleTreeProjectionData
): BulkExperimentVisibleProjection {
  return {
    getParentIndex: projection.getParentIndex,
    paths: projection.paths,
    posInSetByIndex: projection.posInSetByIndex,
    setSizeByIndex: projection.setSizeByIndex,
    visibleIndexByPath: projection.visibleIndexByPath,
  };
}

async function yieldForNextTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

// Validates that the generated preview slice and fetched asset still describe the
// same workload so appendPreparedInput can stay on its append-only fast path.
function assertPreviewPrefix(
  previewPaths: readonly string[],
  fullPaths: readonly string[],
  workloadName: string
): void {
  const previewLength = previewPaths.length;
  const previewPrefix = fullPaths.slice(0, previewLength);
  if (
    previewPrefix.length !== previewLength ||
    previewPrefix.some((path, index) => path !== previewPaths[index])
  ) {
    throw new Error(
      `${workloadName} preview seed is not a prefix of the fetched workload asset.`
    );
  }
}

function createInitialMetrics(
  config: BulkExperimentInitOptions
): BulkExperimentRunMetrics {
  return {
    applyMs: 0,
    completedAt: 0,
    expansionMode: config.expansionMode,
    fetchCompletedAt: null,
    fetchMs: 0,
    headChunk: null,
    headChunkSize:
      config.ingestMode === 'head-start' ? config.headChunkSize : null,
    ingestMode: config.ingestMode,
    parseCompletedAt: null,
    parseMs: 0,
    tailChunks: [],
    totalMs: 0,
    workloadName: config.workloadName,
  };
}

// Owns the experiment's PathStore and exposes a tiny snapshot/query surface that
// can run directly on the main thread or behind a worker message boundary.
export class BulkExperimentModel {
  readonly #ancestorPathsByIndex = new Map<number, readonly string[]>();
  readonly #config: BulkExperimentInitOptions;
  #bulkInfo: BulkExperimentSnapshot['bulkInfo'];
  #disposed = false;
  #estimateStrategy: EstimateStrategy = 'exact-final';
  #estimatedVisibleCount = 0;
  #fetchedPaths: readonly string[] | null = null;
  #getParentIndexForVisibleRow = (_index: number): number => -1;
  #ingestAbortController: AbortController | null = null;
  readonly #listeners = new Set<SnapshotListener>();
  #materializedVisibleCount = 0;
  #metrics: BulkExperimentRunMetrics | null = null;
  #projectionPaths: readonly string[] = [];
  #projectionPosInSetByIndex: ProjectionIndexBuffer = new Int32Array(0);
  #projectionSetSizeByIndex: ProjectionIndexBuffer = new Int32Array(0);
  #projectionVisibleIndexByPath = new Map<string, number>();
  #rawVisibleCount = 0;
  readonly #store: PathStore;
  #unresolvedFrontier: BulkExperimentUnresolvedFrontier | null = null;

  public constructor(config: BulkExperimentInitOptions) {
    this.#config = config;
    this.#bulkInfo = {
      ingestedPathCount: config.previewPaths.length,
      status: 'idle',
      totalPathCount: config.totalPathCount,
    };
    this.#store = new PathStore({
      flattenEmptyDirectories: false,
      ...getBulkExperimentExpansionOptions(
        config.workloadName,
        config.expansionMode
      ),
      preparedInput: PathStore.preparePresortedInput(config.previewPaths),
    });
    this.#rebuildVisibleProjection();
  }

  public destroy(): void {
    this.#disposed = true;
    this.#ingestAbortController?.abort();
    this.#ingestAbortController = null;
    this.#listeners.clear();
  }

  public subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public getSnapshot(): BulkExperimentSnapshot {
    return {
      bulkInfo: { ...this.#bulkInfo },
      estimatedVisibleCount: this.#estimatedVisibleCount,
      expansionMode: this.#config.expansionMode,
      headChunkSize: this.#config.headChunkSize,
      ingestMode: this.#config.ingestMode,
      materializedVisibleCount: this.#materializedVisibleCount,
      metrics: this.#metrics,
      unresolvedFrontier: this.#unresolvedFrontier,
      visibleCount: this.#rawVisibleCount,
      workloadName: this.#config.workloadName,
    };
  }

  public getVisibleRows(
    start: number,
    end: number
  ): readonly BulkExperimentVisibleRow[] {
    if (end < start || this.#materializedVisibleCount === 0) {
      return [];
    }

    const boundedStart = Math.max(0, start);
    const boundedEnd = Math.min(this.#materializedVisibleCount - 1, end);
    if (boundedEnd < boundedStart) {
      return [];
    }

    return this.#store
      .getVisibleSlice(boundedStart, boundedEnd)
      .map((row: PathStoreVisibleRow, offset: number) => {
        const index = boundedStart + offset;
        const projectionPath = this.#projectionPaths[index];
        if (projectionPath == null) {
          throw new Error(
            `Missing projection path for visible index ${String(index)}`
          );
        }

        return {
          ancestorPaths: this.#getAncestorPaths(index),
          depth: row.depth,
          flattenedSegments: row.flattenedSegments?.map((segment) => ({
            isTerminal: segment.isTerminal,
            name: segment.name,
            path: segment.path,
          })),
          hasChildren: row.hasChildren,
          index,
          isExpanded: row.isExpanded,
          isFlattened: row.isFlattened,
          kind: row.kind,
          level: row.depth,
          name: row.name,
          path: projectionPath,
          posInSet: this.#projectionPosInSetByIndex[index] ?? 0,
          setSize: this.#projectionSetSizeByIndex[index] ?? 0,
        } satisfies BulkExperimentVisibleRow;
      });
  }

  public getVisibleIndex(path: string): number | null {
    const visibleIndex = this.#projectionVisibleIndexByPath.get(path);
    return visibleIndex == null ||
      visibleIndex >= this.#materializedVisibleCount
      ? null
      : visibleIndex;
  }

  public async startIngest(): Promise<void> {
    if (
      this.#bulkInfo.status !== 'idle' ||
      this.#ingestAbortController != null ||
      this.#disposed
    ) {
      return;
    }

    this.#metrics = createInitialMetrics(this.#config);
    this.#bulkInfo = {
      errorMessage: undefined,
      ingestedPathCount: this.#config.previewPaths.length,
      status: 'ingesting',
      totalPathCount: this.#config.totalPathCount,
    };
    this.#rebuildVisibleProjection();
    this.#emit();

    const abortController = new AbortController();
    this.#ingestAbortController = abortController;
    void this.#runIngest(abortController.signal);
  }

  public cancelIngest(): void {
    this.#ingestAbortController?.abort();
  }

  public expandPath(path: string): void {
    this.#withDirectoryPath(path, (canonicalPath) => {
      this.#store.expand(canonicalPath);
      this.#markEstimateDirty();
      this.#rebuildVisibleProjection();
      this.#emit();
    });
  }

  public collapsePath(path: string): void {
    this.#withDirectoryPath(path, (canonicalPath) => {
      this.#store.collapse(canonicalPath);
      this.#markEstimateDirty();
      this.#rebuildVisibleProjection();
      this.#emit();
    });
  }

  #markEstimateDirty(): void {
    if (
      this.#bulkInfo.status === 'idle' ||
      this.#bulkInfo.status === 'ingesting'
    ) {
      this.#estimateStrategy = 'minimal-frontier';
    }
  }

  #getAncestorPaths(index: number): readonly string[] {
    const cached = this.#ancestorPathsByIndex.get(index);
    if (cached != null) {
      return cached;
    }

    const parentIndex = this.#getParentIndexForVisibleRow(index);
    const ancestorPaths =
      parentIndex < 0
        ? []
        : [
            ...this.#getAncestorPaths(parentIndex),
            this.#projectionPaths[parentIndex] ?? '',
          ].filter((path) => path !== '');
    this.#ancestorPathsByIndex.set(index, ancestorPaths);
    return ancestorPaths;
  }

  #rebuildVisibleProjection(): void {
    const projection = createVisibleProjection(
      this.#store.getVisibleTreeProjectionData()
    );

    this.#ancestorPathsByIndex.clear();
    this.#rawVisibleCount = this.#store.getVisibleCount();
    this.#getParentIndexForVisibleRow = projection.getParentIndex;
    this.#projectionPaths = projection.paths;
    this.#projectionPosInSetByIndex = projection.posInSetByIndex;
    this.#projectionSetSizeByIndex = projection.setSizeByIndex;
    this.#projectionVisibleIndexByPath = projection.visibleIndexByPath;

    const { materializedVisibleCount, unresolvedFrontier } =
      this.#resolveMaterializedFrontier();
    this.#materializedVisibleCount = materializedVisibleCount;
    this.#unresolvedFrontier = unresolvedFrontier;
    this.#estimatedVisibleCount = this.#resolveEstimatedVisibleCount(
      materializedVisibleCount,
      unresolvedFrontier
    );
  }

  #resolveEstimatedVisibleCount(
    materializedVisibleCount: number,
    unresolvedFrontier: BulkExperimentUnresolvedFrontier | null
  ): number {
    if (this.#bulkInfo.status === 'completed') {
      return this.#rawVisibleCount;
    }

    if (
      this.#bulkInfo.status === 'cancelled' ||
      this.#bulkInfo.status === 'failed'
    ) {
      return materializedVisibleCount;
    }

    if (this.#estimateStrategy === 'exact-final') {
      return Math.max(this.#config.finalVisibleCount, materializedVisibleCount);
    }

    return unresolvedFrontier == null
      ? materializedVisibleCount
      : materializedVisibleCount + 1;
  }

  #resolveMaterializedFrontier(): {
    materializedVisibleCount: number;
    unresolvedFrontier: BulkExperimentUnresolvedFrontier | null;
  } {
    if (
      this.#fetchedPaths == null ||
      this.#rawVisibleCount === 0 ||
      this.#bulkInfo.status === 'completed' ||
      this.#bulkInfo.status === 'cancelled' ||
      this.#bulkInfo.status === 'failed' ||
      this.#bulkInfo.ingestedPathCount >= this.#fetchedPaths.length
    ) {
      return {
        materializedVisibleCount: this.#rawVisibleCount,
        unresolvedFrontier: null,
      };
    }

    const pendingNode = this.#findFirstVisiblePendingNode();
    if (pendingNode == null) {
      return {
        materializedVisibleCount: this.#rawVisibleCount,
        unresolvedFrontier: null,
      };
    }

    return {
      materializedVisibleCount:
        this.#findInsertionIndexForPendingNode(pendingNode),
      unresolvedFrontier: {
        kind: pendingNode.parentPath == null ? 'global' : 'subtree',
        level: pendingNode.level,
        parentPath: pendingNode.parentPath,
      },
    };
  }

  #findFirstVisiblePendingNode(): PendingVisibleNode | null {
    const fetchedPaths = this.#fetchedPaths;
    if (fetchedPaths == null) {
      return null;
    }

    for (
      let index = this.#bulkInfo.ingestedPathCount;
      index < fetchedPaths.length;
      index += 1
    ) {
      const pendingNode = this.#getFirstVisiblePendingNodeForPath(
        fetchedPaths[index]
      );
      if (pendingNode != null) {
        return pendingNode;
      }
    }

    return null;
  }

  #getFirstVisiblePendingNodeForPath(
    path: string | undefined
  ): PendingVisibleNode | null {
    if (path == null) {
      return null;
    }

    const segments = path.split('/');
    let parentPath: string | null = null;

    for (let index = 0; index < segments.length; index += 1) {
      const isTerminalFile = index === segments.length - 1;
      const candidatePath = isTerminalFile
        ? path
        : `${segments.slice(0, index + 1).join('/')}/`;
      const pathInfo = this.#store.getPathInfo(candidatePath);

      if (pathInfo == null) {
        return parentPath == null || this.#isDirectoryExpanded(parentPath)
          ? { level: index, parentPath, path: candidatePath }
          : null;
      }

      if (pathInfo.kind !== 'directory') {
        return null;
      }

      if (!this.#isDirectoryExpanded(pathInfo.path)) {
        return null;
      }

      parentPath = pathInfo.path;
    }

    return null;
  }

  #isDirectoryExpanded(path: string): boolean {
    const visibleIndex = this.#projectionVisibleIndexByPath.get(path);
    if (visibleIndex == null) {
      return false;
    }

    const row = this.#store.getVisibleSlice(visibleIndex, visibleIndex)[0];
    return row?.kind === 'directory' ? row.isExpanded : false;
  }

  #findInsertionIndexForPendingNode(pendingNode: PendingVisibleNode): number {
    if (pendingNode.parentPath == null) {
      return this.#rawVisibleCount;
    }

    const lastVisibleDescendantIndex = this.#findLastVisibleIndexWithPrefix(
      pendingNode.parentPath
    );
    return lastVisibleDescendantIndex < 0
      ? this.#rawVisibleCount
      : lastVisibleDescendantIndex + 1;
  }

  #findLastVisibleIndexWithPrefix(prefix: string): number {
    for (let index = this.#rawVisibleCount - 1; index >= 0; index -= 1) {
      const path = this.#projectionPaths[index];
      if (path != null && path.startsWith(prefix)) {
        return index;
      }
    }

    return -1;
  }

  #emit(): void {
    if (this.#disposed) {
      return;
    }

    const snapshot = this.getSnapshot();
    this.#listeners.forEach((listener) => {
      listener(snapshot);
    });
  }

  #withDirectoryPath(
    path: string,
    action: (canonicalPath: string) => void
  ): void {
    if (this.#disposed) {
      return;
    }

    const pathInfo = this.#store.getPathInfo(path);
    if (pathInfo?.kind !== 'directory') {
      return;
    }

    action(pathInfo.path);
  }

  #applySeededExpansions(): void {
    if (this.#config.expansionMode !== 'seeded') {
      return;
    }

    for (const path of this.#config.seededExpandedPaths) {
      const pathInfo = this.#store.getPathInfo(path);
      if (pathInfo?.kind !== 'directory') {
        continue;
      }

      this.#store.expand(pathInfo.path);
    }
  }

  #appendPresortedPaths(
    paths: readonly string[],
    nextIngestedPathCount: number
  ): void {
    if (paths.length === 0 || this.#disposed) {
      return;
    }

    this.#store.appendPreparedInput(PathStore.preparePresortedInput(paths));
    this.#applySeededExpansions();
    this.#bulkInfo = {
      ...this.#bulkInfo,
      ingestedPathCount: nextIngestedPathCount,
    };
    this.#rebuildVisibleProjection();
  }

  #recordChunkMilestone(kind: 'head' | 'tail', runStartedAt: number): void {
    if (this.#metrics == null) {
      return;
    }

    const milestone: BulkExperimentChunkMilestone = {
      completedAt: now() - runStartedAt,
      estimatedVisibleCount: this.#estimatedVisibleCount,
      ingestedPathCount: this.#bulkInfo.ingestedPathCount,
      materializedVisibleCount: this.#materializedVisibleCount,
    };
    this.#metrics =
      kind === 'head'
        ? { ...this.#metrics, headChunk: milestone }
        : {
            ...this.#metrics,
            tailChunks: [...this.#metrics.tailChunks, milestone],
          };
  }

  #updatePayloadTimings(timings: UpgradePayloadTimings): void {
    if (this.#metrics == null) {
      return;
    }

    this.#metrics = {
      ...this.#metrics,
      fetchCompletedAt: timings.fetchMs,
      fetchMs: timings.fetchMs,
      parseCompletedAt: timings.fetchMs + timings.parseMs,
      parseMs: timings.parseMs,
    };
  }

  #finalizeRun(
    status: BulkExperimentSnapshot['bulkInfo']['status'],
    timings: UpgradePayloadTimings,
    applyStartedAt: number,
    runStartedAt: number,
    errorMessage?: string
  ): void {
    const applyMs = applyStartedAt === 0 ? 0 : now() - applyStartedAt;
    if (this.#metrics != null) {
      this.#metrics = {
        ...this.#metrics,
        applyMs,
        completedAt: now() - runStartedAt,
        fetchCompletedAt: timings.fetchMs === 0 ? null : timings.fetchMs,
        fetchMs: timings.fetchMs,
        parseCompletedAt:
          timings.parseMs === 0 && timings.fetchMs === 0
            ? null
            : timings.fetchMs + timings.parseMs,
        parseMs: timings.parseMs,
        totalMs: now() - runStartedAt,
      };
    }
    this.#bulkInfo = {
      errorMessage,
      ingestedPathCount: this.#bulkInfo.ingestedPathCount,
      status,
      totalPathCount: this.#bulkInfo.totalPathCount,
    };
    this.#rebuildVisibleProjection();
    this.#emit();
  }

  #createChunkedTailPlan(
    remainingPaths: readonly string[],
    previewLength: number
  ): Array<{
    kind: 'tail';
    nextIngestedPathCount: number;
    paths: readonly string[];
  }> {
    const chunks: Array<{
      kind: 'tail';
      nextIngestedPathCount: number;
      paths: readonly string[];
    }> = [];

    for (
      let index = 0;
      index < remainingPaths.length;
      index += BULK_EXPERIMENT_CHUNK_SIZE
    ) {
      const chunk = remainingPaths.slice(
        index,
        index + BULK_EXPERIMENT_CHUNK_SIZE
      );
      chunks.push({
        kind: 'tail',
        nextIngestedPathCount: previewLength + index + chunk.length,
        paths: chunk,
      });
    }

    return chunks;
  }

  #createHeadStartPlan(
    remainingPaths: readonly string[],
    previewLength: number
  ): Array<{
    kind: 'head' | 'tail';
    nextIngestedPathCount: number;
    paths: readonly string[];
  }> {
    const plan: Array<{
      kind: 'head' | 'tail';
      nextIngestedPathCount: number;
      paths: readonly string[];
    }> = [];
    const headChunkSize = Math.min(
      remainingPaths.length,
      this.#config.headChunkSize
    );
    if (headChunkSize > 0) {
      plan.push({
        kind: 'head',
        nextIngestedPathCount: previewLength + headChunkSize,
        paths: remainingPaths.slice(0, headChunkSize),
      });
    }

    const tailPaths = remainingPaths.slice(headChunkSize);
    if (tailPaths.length === 0) {
      return plan;
    }

    const tailChunkSize = Math.ceil(
      tailPaths.length / BULK_EXPERIMENT_HEAD_START_TAIL_CHUNK_COUNT
    );
    for (let index = 0; index < tailPaths.length; index += tailChunkSize) {
      const chunk = tailPaths.slice(index, index + tailChunkSize);
      plan.push({
        kind: 'tail',
        nextIngestedPathCount:
          previewLength + headChunkSize + index + chunk.length,
        paths: chunk,
      });
    }

    return plan;
  }

  async #runIngest(signal: AbortSignal): Promise<void> {
    const runStartedAt = now();
    const timings: UpgradePayloadTimings = { fetchMs: 0, parseMs: 0 };
    let applyStartedAt = 0;

    try {
      const { payload, timings: nextTimings } =
        await fetchUpgradePayloadWithTimings(this.#config.assetUrl, signal);
      timings.fetchMs = nextTimings.fetchMs;
      timings.parseMs = nextTimings.parseMs;
      if (signal.aborted) {
        throw createAbortError();
      }

      assertPreviewPrefix(
        this.#config.previewPaths,
        payload.paths,
        this.#config.workloadName
      );

      this.#fetchedPaths = payload.paths;
      this.#bulkInfo = {
        ...this.#bulkInfo,
        totalPathCount: payload.paths.length,
      };
      this.#updatePayloadTimings(timings);
      this.#rebuildVisibleProjection();
      this.#emit();

      const previewLength = this.#config.previewPaths.length;
      const remainingPaths = payload.paths.slice(previewLength);
      applyStartedAt = now();

      if (this.#config.ingestMode === 'oneshot') {
        this.#appendPresortedPaths(remainingPaths, payload.paths.length);
        this.#emit();
      } else {
        const plan =
          this.#config.ingestMode === 'head-start'
            ? this.#createHeadStartPlan(remainingPaths, previewLength)
            : this.#createChunkedTailPlan(remainingPaths, previewLength);

        for (let index = 0; index < plan.length; index += 1) {
          if (signal.aborted) {
            throw createAbortError();
          }

          const chunk = plan[index];
          this.#appendPresortedPaths(chunk.paths, chunk.nextIngestedPathCount);
          this.#recordChunkMilestone(chunk.kind, runStartedAt);
          this.#emit();
          if (index < plan.length - 1) {
            await yieldForNextTurn();
          }
        }
      }

      this.#finalizeRun('completed', timings, applyStartedAt, runStartedAt);
    } catch (error) {
      if (this.#disposed) {
        return;
      }

      if (isAbortError(error) || signal.aborted) {
        this.#finalizeRun('cancelled', timings, applyStartedAt, runStartedAt);
      } else {
        this.#finalizeRun(
          'failed',
          timings,
          applyStartedAt,
          runStartedAt,
          toErrorMessage(error)
        );
      }
    } finally {
      if (this.#ingestAbortController?.signal === signal) {
        this.#ingestAbortController = null;
      }
    }
  }
}
