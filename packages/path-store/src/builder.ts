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
  private hasDeferredDirectoryIndexes = false;

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
        let previousPath: string | null = null;
        let currentDepth = 0;
        const nodes = this.nodes;
        const segmentTable = this.segmentTable;
        const dirStack = this.directoryStack;
        let stackTop = 0;

        for (const path of paths) {
          if (previousPath === path) {
            throw new Error(`Duplicate path: "${path}"`);
          }

          // Inline prefix comparison to avoid per-path result object
          // allocation and function-call overhead.
          const hasTrailingSlash =
            path.length > 0 && path.charCodeAt(path.length - 1) === 47;
          const endIndex = hasTrailingSlash ? path.length - 1 : path.length;
          let sharedDirectoryDepth = 0;
          let unsharedSegmentStart = 0;

          if (previousPath != null) {
            const compareLength = Math.min(endIndex, previousPath.length);
            let prefixMatched = true;
            for (let ci = 0; ci < compareLength; ci++) {
              const cc = path.charCodeAt(ci);
              if (cc !== previousPath.charCodeAt(ci)) {
                prefixMatched = false;
                break;
              }
              if (cc === 47) {
                sharedDirectoryDepth++;
                unsharedSegmentStart = ci + 1;
              }
            }
            if (
              prefixMatched &&
              hasTrailingSlash &&
              compareLength === endIndex &&
              previousPath.length > endIndex &&
              previousPath.charCodeAt(endIndex) === 47
            ) {
              sharedDirectoryDepth++;
              unsharedSegmentStart = endIndex + 1;
            }
          }

          stackTop = sharedDirectoryDepth;
          currentDepth = sharedDirectoryDepth;

          let segmentStart = unsharedSegmentStart;
          for (let index = unsharedSegmentStart; index < endIndex; index++) {
            if (path.charCodeAt(index) !== 47) {
              continue;
            }

            const parentId = dirStack[stackTop];
            if (parentId === undefined) {
              throw new Error(
                'Directory stack underflow while building the path store'
              );
            }

            currentDepth++;
            const nodeId = nodes.length;
            nodes.push({
              depth: currentDepth,
              flags: 0,
              id: nodeId,
              kind: PATH_STORE_NODE_KIND_DIRECTORY,
              nameId: internSegment(
                segmentTable,
                path.slice(segmentStart, index)
              ),
              parentId,
              pathCache: null,
              pathCacheVersion: 0,
              subtreeNodeCount: 1,
              visibleSubtreeCount: 1,
            });
            stackTop++;
            dirStack[stackTop] = nodeId;
            segmentStart = index + 1;
          }

          if (hasTrailingSlash) {
            if (segmentStart < endIndex) {
              const parentId = dirStack[stackTop];
              if (parentId === undefined) {
                throw new Error(
                  `Unable to resolve directory parent for "${path}"`
                );
              }

              currentDepth++;
              const nodeId = nodes.length;
              nodes.push({
                depth: currentDepth,
                flags: 0,
                id: nodeId,
                kind: PATH_STORE_NODE_KIND_DIRECTORY,
                nameId: internSegment(
                  segmentTable,
                  path.slice(segmentStart, endIndex)
                ),
                parentId,
                pathCache: null,
                pathCacheVersion: 0,
                subtreeNodeCount: 1,
                visibleSubtreeCount: 1,
              });
              stackTop++;
              dirStack[stackTop] = nodeId;
            }

            const directoryId = dirStack[stackTop];
            if (directoryId === undefined) {
              throw new Error(`Unable to resolve directory node for "${path}"`);
            }

            this.promoteDirectoryToExplicit(directoryId, path);
          } else {
            const parentId = dirStack[stackTop];
            if (parentId === undefined) {
              throw new Error(`Unable to resolve file parent for "${path}"`);
            }

            const nodeId = nodes.length;
            nodes.push({
              depth: currentDepth + 1,
              flags: 0,
              id: nodeId,
              kind: PATH_STORE_NODE_KIND_FILE,
              nameId: internSegment(segmentTable, path.slice(segmentStart)),
              parentId,
              pathCache: null,
              pathCacheVersion: -1,
              subtreeNodeCount: 1,
              visibleSubtreeCount: 1,
            });
          }

          previousPath = path;
        }

        // Sync directory stack length for potential subsequent non-presorted
        // operations.
        dirStack.length = stackTop + 1;

        if (previousPath != null) {
          this.lastPreparedPath = parseInputPath(previousPath);
        }

        this.hasDeferredDirectoryIndexes = true;
      }
    );

    return this;
  }

  public finish(): PathStoreSnapshot {
    if (this.hasDeferredDirectoryIndexes) {
      withBenchmarkPhase(
        this.instrumentation,
        'store.builder.buildDirectoryIndexes',
        () => this.buildDirectoryIndexes()
      );
      this.hasDeferredDirectoryIndexes = false;
    }

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
    if (this.hasDeferredDirectoryIndexes) {
      this.buildDirectoryIndexes();
      this.hasDeferredDirectoryIndexes = false;
    }

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

  // Builds full directory-child indexes for all nodes created during the
  // presorted fast path, which defers index creation to avoid per-child Map
  // operations during the hot ingest loop.
  private buildDirectoryIndexes(): void {
    const nodes = this.nodes;

    for (let nodeId = 1; nodeId < nodes.length; nodeId++) {
      const node = nodes[nodeId];
      if (node == null) {
        continue;
      }

      // Create a directory-child index for every directory that does not
      // already have one (root is set up in the constructor).
      if (node.kind === PATH_STORE_NODE_KIND_DIRECTORY) {
        this.directories.set(nodeId, createDirectoryChildIndex());
      }

      // Register this node as a child of its parent.  Node IDs are assigned
      // sequentially during presorted construction, so iterating in ID order
      // preserves the canonical sorted child order.
      const parentIndex = this.directories.get(node.parentId);
      if (parentIndex != null) {
        parentIndex.childIdByNameId.set(node.nameId, nodeId);
        appendChildReference(parentIndex, nodeId);
      }
    }
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
