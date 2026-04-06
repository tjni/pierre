import { appendChildReference, createDirectoryChildIndex } from './child-index';
import { rebuildDirectoryChildAggregates } from './child-index';
import type {
  DirectoryChildIndex,
  InternalPreparedInput,
  NodeId,
  PathStoreNode,
  PathStoreSnapshot,
  PreparedPath,
  ResolvedPathStoreOptions,
  SegmentSortKey,
} from './internal-types';
import { PATH_STORE_NODE_FLAG_EXPLICIT } from './internal-types';
import { PATH_STORE_NODE_FLAG_ROOT } from './internal-types';
import { PATH_STORE_NODE_KIND_DIRECTORY } from './internal-types';
import { PATH_STORE_NODE_KIND_FILE } from './internal-types';
import {
  getBenchmarkInstrumentation,
  setBenchmarkCounter,
  withBenchmarkPhase,
} from './internal/benchmarkInstrumentation';
import type { BenchmarkInstrumentation } from './internal/benchmarkInstrumentation';
import { resolvePathStoreOptions } from './options';
import { parseInputPath } from './path';
import type {
  PathStoreCompareEntry,
  PathStoreOptions,
  PathStorePathComparator,
} from './public-types';
import { internSegment } from './segments';
import { createSegmentTable } from './segments';
import {
  comparePreparedPaths,
  comparePreparedPathsWithCachedSortKeys,
} from './sort';

function createCompareEntry(preparedPath: PreparedPath): PathStoreCompareEntry {
  return {
    basename: preparedPath.basename,
    depth: preparedPath.segments.length,
    isDirectory: preparedPath.isDirectory,
    path: preparedPath.path,
    segments: preparedPath.segments,
  };
}

function compareWithSortOption(
  left: PreparedPath,
  right: PreparedPath,
  sort: 'default' | PathStorePathComparator
): number {
  if (sort === 'default') {
    return comparePreparedPaths(left, right);
  }

  return sort(createCompareEntry(left), createCompareEntry(right));
}

function createRootNode(): PathStoreNode {
  return {
    depth: 0,
    flags: PATH_STORE_NODE_FLAG_EXPLICIT | PATH_STORE_NODE_FLAG_ROOT,
    id: 0,
    kind: PATH_STORE_NODE_KIND_DIRECTORY,
    nameId: 0,
    parentId: 0,
    pathCache: '',
    pathCacheVersion: 0,
    subtreeNodeCount: 1,
    visibleSubtreeCount: 1,
  };
}

function computeSharedPrefixLength(
  left: readonly string[],
  right: readonly string[]
): number {
  const maxLength = Math.min(left.length, right.length);
  for (let index = 0; index < maxLength; index++) {
    if (left[index] !== right[index]) {
      return index;
    }
  }

  return maxLength;
}

// The presorted builder path can compute segment splits and shared-prefix depth
// together so it does not need a second pass over the parsed segment array.
function splitPresortedInputPath(
  inputPath: string,
  previousSegments: readonly string[]
): {
  hasTrailingSlash: boolean;
  segments: readonly string[];
  sharedPrefixLength: number;
} {
  const hasTrailingSlash =
    inputPath.length > 0 && inputPath.charCodeAt(inputPath.length - 1) === 47;
  const endIndex = hasTrailingSlash ? inputPath.length - 1 : inputPath.length;
  const segments: string[] = [];
  let segmentStart = 0;
  let sharedPrefixLength = 0;
  let segmentIndex = 0;
  let prefixStillShared = true;

  for (let index = 0; index < endIndex; index++) {
    if (inputPath.charCodeAt(index) !== 47) {
      continue;
    }

    const segment = inputPath.slice(segmentStart, index);
    segments.push(segment);
    if (prefixStillShared) {
      if (previousSegments[segmentIndex] === segment) {
        sharedPrefixLength++;
      } else {
        prefixStillShared = false;
      }
    }

    segmentIndex++;
    segmentStart = index + 1;
  }

  const finalSegment = inputPath.slice(segmentStart, endIndex);
  segments.push(finalSegment);
  if (prefixStillShared) {
    if (previousSegments[segmentIndex] === finalSegment) {
      sharedPrefixLength++;
    }
  }

  return {
    hasTrailingSlash,
    segments,
    sharedPrefixLength,
  };
}

function getDirectoryDepth(preparedPath: PreparedPath): number {
  return preparedPath.isDirectory
    ? preparedPath.segments.length
    : preparedPath.segments.length - 1;
}

function isPreparedPathArray(value: unknown): value is readonly PreparedPath[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry != null &&
        typeof entry === 'object' &&
        typeof entry.path === 'string' &&
        Array.isArray(entry.segments) &&
        typeof entry.basename === 'string' &&
        typeof entry.isDirectory === 'boolean'
    )
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

export function preparePaths(
  paths: readonly string[],
  options: PathStoreOptions = {}
): string[] {
  return preparePathEntries(paths, options).map((entry) => entry.path);
}

export function prepareInput(
  paths: readonly string[],
  options: PathStoreOptions = {}
): InternalPreparedInput {
  const preparedPaths = preparePathEntries(paths, options);
  return {
    paths: preparedPaths.map((entry) => entry.path),
    preparedPaths,
  };
}

export function preparePresortedInput(
  paths: readonly string[]
): InternalPreparedInput {
  const presortedPaths = [...paths];
  return {
    paths: presortedPaths,
    presortedPaths,
  };
}

export function getPreparedInputEntries(
  preparedInput: import('./public-types').PathStorePreparedInput
): readonly PreparedPath[] {
  const internalPreparedInput = preparedInput as Partial<InternalPreparedInput>;
  const preparedPaths = internalPreparedInput.preparedPaths;
  if (!isPreparedPathArray(preparedPaths)) {
    throw new Error('preparedInput must come from PathStore.prepareInput()');
  }

  return preparedPaths;
}

export function getPreparedInputPresortedPaths(
  preparedInput: import('./public-types').PathStorePreparedInput
): readonly string[] | null {
  const internalPreparedInput = preparedInput as Partial<InternalPreparedInput>;
  return isStringArray(internalPreparedInput.presortedPaths)
    ? internalPreparedInput.presortedPaths
    : null;
}

export function preparePathEntries(
  paths: readonly string[],
  options: PathStoreOptions = {}
): PreparedPath[] {
  const resolvedOptions = resolvePathStoreOptions(options);
  const instrumentation = getBenchmarkInstrumentation(options);
  setBenchmarkCounter(instrumentation, 'workload.inputFiles', paths.length);
  const preparedPaths = withBenchmarkPhase(
    instrumentation,
    'store.preparePathEntries.parse',
    () => paths.map((path) => parseInputPath(path))
  );

  withBenchmarkPhase(instrumentation, 'store.preparePathEntries.sort', () =>
    preparedPaths.sort((left, right) =>
      compareWithSortOption(left, right, resolvedOptions.sort)
    )
  );

  return preparedPaths;
}

export class PathStoreBuilder {
  private readonly directories = new Map<NodeId, DirectoryChildIndex>();
  private readonly directoryStack: NodeId[] = [0];
  private lastPreparedPath: PreparedPath | null = null;
  private readonly nodes: PathStoreNode[] = [createRootNode()];
  private readonly options: ResolvedPathStoreOptions;
  private readonly instrumentation: BenchmarkInstrumentation | null;
  private readonly segmentSortKeyCache = new Map<string, SegmentSortKey>();
  private readonly segmentTable = createSegmentTable();

  public constructor(options: PathStoreOptions = {}) {
    this.instrumentation = getBenchmarkInstrumentation(options);
    this.options = resolvePathStoreOptions(options);
    this.directories.set(0, createDirectoryChildIndex());
  }

  public appendPaths(paths: readonly string[]): this {
    return withBenchmarkPhase(
      this.instrumentation,
      'store.builder.appendPaths.parse',
      () => this.appendPreparedPaths(paths.map((path) => parseInputPath(path)))
    );
  }

  public appendPreparedPaths(
    preparedPaths: readonly PreparedPath[],
    validateOrder = true
  ): this {
    withBenchmarkPhase(
      this.instrumentation,
      'store.builder.appendPreparedPaths',
      () => {
        for (const preparedPath of preparedPaths) {
          this.appendPreparedPath(preparedPath, validateOrder);
        }
      }
    );

    return this;
  }

  public appendPresortedPaths(paths: readonly string[]): this {
    withBenchmarkPhase(
      this.instrumentation,
      'store.builder.appendPresortedPaths',
      () => {
        let previousDirectoryDepth = 0;
        let previousPath: string | null = null;
        let previousSegments: readonly string[] = [];

        for (const path of paths) {
          if (previousPath === path) {
            throw new Error(`Duplicate path: "${path}"`);
          }

          const { hasTrailingSlash, segments, sharedPrefixLength } =
            splitPresortedInputPath(path, previousSegments);
          const currentDirectoryDepth = hasTrailingSlash
            ? segments.length
            : segments.length - 1;
          const sharedDirectoryDepth =
            previousPath == null
              ? 0
              : Math.min(
                  sharedPrefixLength,
                  previousDirectoryDepth,
                  currentDirectoryDepth
                );

          this.directoryStack.length = sharedDirectoryDepth + 1;

          for (
            let segmentIndex = sharedDirectoryDepth;
            segmentIndex < currentDirectoryDepth;
            segmentIndex++
          ) {
            const parentId =
              this.directoryStack[this.directoryStack.length - 1];
            if (parentId === undefined) {
              throw new Error(
                'Directory stack underflow while building the path store'
              );
            }

            const childId = this.createDirectoryChild(
              parentId,
              segments[segmentIndex]
            );
            this.directoryStack.push(childId);
          }

          if (hasTrailingSlash) {
            const directoryId =
              this.directoryStack[this.directoryStack.length - 1];
            if (directoryId === undefined) {
              throw new Error(`Unable to resolve directory node for "${path}"`);
            }

            this.promoteDirectoryToExplicit(directoryId, path);
          } else {
            const parentId =
              this.directoryStack[this.directoryStack.length - 1];
            if (parentId === undefined) {
              throw new Error(`Unable to resolve file parent for "${path}"`);
            }

            const basename = segments[segments.length - 1] ?? '';
            this.createFileChildUnchecked(parentId, basename);
          }

          previousDirectoryDepth = currentDirectoryDepth;
          previousPath = path;
          previousSegments = segments;
        }

        if (previousPath != null) {
          this.lastPreparedPath = parseInputPath(previousPath);
        }
      }
    );

    return this;
  }

  public finish(): PathStoreSnapshot {
    withBenchmarkPhase(
      this.instrumentation,
      'store.builder.computeSubtreeCounts',
      () => this.computeSubtreeCounts(0)
    );
    return {
      directories: this.directories,
      nodes: this.nodes,
      options: this.options,
      rootId: 0,
      segmentTable: this.segmentTable,
    };
  }

  private appendPreparedPath(
    preparedPath: PreparedPath,
    validateOrder: boolean
  ): void {
    if (this.lastPreparedPath != null) {
      if (preparedPath.path === this.lastPreparedPath.path) {
        throw new Error(`Duplicate path: "${preparedPath.path}"`);
      }

      if (validateOrder) {
        const orderComparison =
          this.options.sort === 'default'
            ? comparePreparedPathsWithCachedSortKeys(
                this.lastPreparedPath,
                preparedPath,
                this.segmentSortKeyCache
              )
            : compareWithSortOption(
                this.lastPreparedPath,
                preparedPath,
                this.options.sort
              );
        if (orderComparison > 0) {
          throw new Error(
            `Builder input must be sorted before appendPaths(): "${preparedPath.path}"`
          );
        }
      }
    }

    const previousPath = this.lastPreparedPath;
    const currentDirectoryDepth = getDirectoryDepth(preparedPath);
    const previousDirectoryDepth =
      previousPath == null ? 0 : getDirectoryDepth(previousPath);
    const sharedPrefixLength =
      previousPath == null
        ? 0
        : computeSharedPrefixLength(
            previousPath.segments,
            preparedPath.segments
          );
    const sharedDirectoryDepth = Math.min(
      sharedPrefixLength,
      currentDirectoryDepth,
      previousDirectoryDepth
    );

    this.directoryStack.length = sharedDirectoryDepth + 1;

    for (
      let segmentIndex = sharedDirectoryDepth;
      segmentIndex < currentDirectoryDepth;
      segmentIndex++
    ) {
      const parentId = this.directoryStack[this.directoryStack.length - 1];
      if (parentId === undefined) {
        throw new Error(
          'Directory stack underflow while building the path store'
        );
      }

      const childId = validateOrder
        ? this.getOrCreateDirectoryChild(
            parentId,
            preparedPath.segments[segmentIndex]
          )
        : this.createDirectoryChild(
            parentId,
            preparedPath.segments[segmentIndex]
          );
      this.directoryStack.push(childId);
    }

    if (preparedPath.isDirectory) {
      const directoryId = this.directoryStack[this.directoryStack.length - 1];
      if (directoryId === undefined) {
        throw new Error(
          `Unable to resolve directory node for "${preparedPath.path}"`
        );
      }

      this.promoteDirectoryToExplicit(directoryId, preparedPath.path);
      this.lastPreparedPath = preparedPath;
      return;
    }

    const parentId = this.directoryStack[this.directoryStack.length - 1];
    if (parentId === undefined) {
      throw new Error(
        `Unable to resolve file parent for "${preparedPath.path}"`
      );
    }

    if (validateOrder) {
      this.createFileChild(parentId, preparedPath.basename, preparedPath.path);
    } else {
      this.createFileChildUnchecked(parentId, preparedPath.basename);
    }
    this.lastPreparedPath = preparedPath;
  }

  private createFileChild(
    parentId: NodeId,
    basename: string,
    path: string
  ): NodeId {
    const nameId = internSegment(this.segmentTable, basename);
    const parentIndex = this.getDirectoryIndex(parentId);
    const existingChildId = parentIndex.childIdByNameId.get(nameId);
    if (existingChildId !== undefined) {
      throw new Error(`Path collides with an existing entry: "${path}"`);
    }

    const parentNode = this.nodes[parentId];
    if (parentNode === undefined) {
      throw new Error(`Unknown parent node ID: ${String(parentId)}`);
    }

    const nodeId = this.nodes.length;
    this.nodes.push({
      depth: parentNode.depth + 1,
      flags: 0,
      id: nodeId,
      kind: PATH_STORE_NODE_KIND_FILE,
      nameId,
      parentId,
      pathCache: path,
      pathCacheVersion: 0,
      subtreeNodeCount: 1,
      visibleSubtreeCount: 1,
    });

    parentIndex.childIdByNameId.set(nameId, nodeId);
    appendChildReference(parentIndex, nodeId);
    return nodeId;
  }

  // Bulk-ingested file nodes leave full paths lazy so first render only pays to
  // materialize the tiny visible window instead of caching every file string up
  // front.
  private createFileChildUnchecked(parentId: NodeId, basename: string): NodeId {
    const nameId = internSegment(this.segmentTable, basename);
    const parentIndex = this.getDirectoryIndex(parentId);
    const parentNode = this.nodes[parentId];
    if (parentNode === undefined) {
      throw new Error(`Unknown parent node ID: ${String(parentId)}`);
    }

    const nodeId = this.nodes.length;
    this.nodes.push({
      depth: parentNode.depth + 1,
      flags: 0,
      id: nodeId,
      kind: PATH_STORE_NODE_KIND_FILE,
      nameId,
      parentId,
      pathCache: null,
      pathCacheVersion: -1,
      subtreeNodeCount: 1,
      visibleSubtreeCount: 1,
    });

    parentIndex.childIdByNameId.set(nameId, nodeId);
    appendChildReference(parentIndex, nodeId);
    return nodeId;
  }

  private getOrCreateDirectoryChild(parentId: NodeId, segment: string): NodeId {
    const nameId = internSegment(this.segmentTable, segment);
    const parentIndex = this.getDirectoryIndex(parentId);
    const existingChildId = parentIndex.childIdByNameId.get(nameId);
    if (existingChildId !== undefined) {
      const existingNode = this.nodes[existingChildId];
      if (existingNode?.kind !== PATH_STORE_NODE_KIND_DIRECTORY) {
        throw new Error(
          `Path collides with an existing file while creating directory "${segment}"`
        );
      }

      return existingChildId;
    }

    const parentNode = this.nodes[parentId];
    if (parentNode === undefined) {
      throw new Error(`Unknown parent node ID: ${String(parentId)}`);
    }

    const nodeId = this.nodes.length;
    this.nodes.push({
      depth: parentNode.depth + 1,
      flags: 0,
      id: nodeId,
      kind: PATH_STORE_NODE_KIND_DIRECTORY,
      nameId,
      parentId,
      pathCache: null,
      pathCacheVersion: 0,
      subtreeNodeCount: 1,
      visibleSubtreeCount: 1,
    });

    parentIndex.childIdByNameId.set(nameId, nodeId);
    appendChildReference(parentIndex, nodeId);
    this.directories.set(nodeId, createDirectoryChildIndex());
    return nodeId;
  }

  // Sorted unique prepared input only introduces brand-new directories beyond
  // the shared prefix with the previous path, so no existing-child lookup is
  // required in this fast path.
  private createDirectoryChild(parentId: NodeId, segment: string): NodeId {
    const nameId = internSegment(this.segmentTable, segment);
    const parentIndex = this.getDirectoryIndex(parentId);
    const parentNode = this.nodes[parentId];
    if (parentNode === undefined) {
      throw new Error(`Unknown parent node ID: ${String(parentId)}`);
    }

    const nodeId = this.nodes.length;
    this.nodes.push({
      depth: parentNode.depth + 1,
      flags: 0,
      id: nodeId,
      kind: PATH_STORE_NODE_KIND_DIRECTORY,
      nameId,
      parentId,
      pathCache: null,
      pathCacheVersion: 0,
      subtreeNodeCount: 1,
      visibleSubtreeCount: 1,
    });

    parentIndex.childIdByNameId.set(nameId, nodeId);
    appendChildReference(parentIndex, nodeId);
    this.directories.set(nodeId, createDirectoryChildIndex());
    return nodeId;
  }

  private promoteDirectoryToExplicit(directoryId: NodeId, path: string): void {
    const directoryNode = this.nodes[directoryId];
    if (directoryNode === undefined) {
      throw new Error(`Unknown directory node ID: ${String(directoryId)}`);
    }

    if (directoryNode.kind !== PATH_STORE_NODE_KIND_DIRECTORY) {
      throw new Error(`Path is not a directory: "${path}"`);
    }

    if ((directoryNode.flags & PATH_STORE_NODE_FLAG_EXPLICIT) !== 0) {
      throw new Error(`Duplicate path: "${path}"`);
    }

    directoryNode.flags |= PATH_STORE_NODE_FLAG_EXPLICIT;
    directoryNode.pathCache = path;
  }

  private getDirectoryIndex(directoryId: NodeId): DirectoryChildIndex {
    const existingIndex = this.directories.get(directoryId);
    if (existingIndex !== undefined) {
      return existingIndex;
    }

    throw new Error(
      `Unknown directory child index for node ${String(directoryId)}`
    );
  }

  // Computes subtree counts after bulk ingest so later phases can add
  // projection math without changing the canonical storage layout.
  private computeSubtreeCounts(nodeId: NodeId): number {
    const node = this.nodes[nodeId];
    if (node === undefined) {
      throw new Error(`Unknown node ID: ${String(nodeId)}`);
    }

    if (node.kind === PATH_STORE_NODE_KIND_FILE) {
      node.subtreeNodeCount = 1;
      node.visibleSubtreeCount = 1;
      return 1;
    }

    const directoryIndex = this.getDirectoryIndex(nodeId);
    let subtreeNodeCount = 1;
    for (const childId of directoryIndex.childIds) {
      subtreeNodeCount += this.computeSubtreeCounts(childId);
    }

    // Children already have final counts from the recursive descent above, so
    // the directory can derive its cached child aggregates before writing its
    // own subtree totals.
    rebuildDirectoryChildAggregates(this.nodes, directoryIndex);
    node.subtreeNodeCount = subtreeNodeCount;
    node.visibleSubtreeCount = subtreeNodeCount;
    return subtreeNodeCount;
  }
}
