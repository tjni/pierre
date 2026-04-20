import type { FileTreeBulkIngestInfo } from '@pierre/trees';

import type {
  BulkExperimentExpansionMode,
  BulkExperimentHeadChunkSize,
  BulkExperimentIngestMode,
  BulkExperimentWorkloadName,
} from './bulkExperimentMeta';

export interface BulkExperimentVisibleSegment {
  isTerminal: boolean;
  name: string;
  path: string;
}

export interface BulkExperimentVisibleRow {
  ancestorPaths: readonly string[];
  depth: number;
  flattenedSegments?: readonly BulkExperimentVisibleSegment[];
  hasChildren: boolean;
  index: number;
  isExpanded: boolean;
  isFlattened: boolean;
  kind: 'directory' | 'file';
  level: number;
  name: string;
  path: string;
  posInSet: number;
  setSize: number;
}

export interface BulkExperimentChunkMilestone {
  completedAt: number;
  estimatedVisibleCount: number;
  ingestedPathCount: number;
  materializedVisibleCount: number;
}

export interface BulkExperimentRunMetrics {
  applyMs: number;
  completedAt: number;
  expansionMode: BulkExperimentExpansionMode;
  fetchCompletedAt: number | null;
  fetchMs: number;
  headChunk: BulkExperimentChunkMilestone | null;
  headChunkSize: BulkExperimentHeadChunkSize | null;
  ingestMode: BulkExperimentIngestMode;
  parseCompletedAt: number | null;
  parseMs: number;
  tailChunks: readonly BulkExperimentChunkMilestone[];
  totalMs: number;
  workloadName: BulkExperimentWorkloadName;
}

export interface BulkExperimentUnresolvedFrontier {
  kind: 'global' | 'subtree';
  level: number;
  parentPath: string | null;
}

export interface BulkExperimentSnapshot {
  bulkInfo: FileTreeBulkIngestInfo;
  estimatedVisibleCount: number;
  expansionMode: BulkExperimentExpansionMode;
  headChunkSize: BulkExperimentHeadChunkSize;
  ingestMode: BulkExperimentIngestMode;
  materializedVisibleCount: number;
  metrics: BulkExperimentRunMetrics | null;
  unresolvedFrontier: BulkExperimentUnresolvedFrontier | null;
  visibleCount: number;
  workloadName: BulkExperimentWorkloadName;
}

export interface BulkExperimentInitOptions {
  assetUrl: string;
  expansionMode: BulkExperimentExpansionMode;
  finalVisibleCount: number;
  headChunkSize: BulkExperimentHeadChunkSize;
  ingestMode: BulkExperimentIngestMode;
  previewPaths: readonly string[];
  previewVisibleCount: number;
  seededExpandedPaths: readonly string[];
  totalPathCount: number;
  workloadName: BulkExperimentWorkloadName;
}

export type BulkExperimentWorkerRequest =
  | { id: number; type: 'cancelIngest' }
  | { id: number; type: 'collapsePath'; path: string }
  | { id: number; type: 'dispose' }
  | { id: number; type: 'expandPath'; path: string }
  | { id: number; type: 'getVisibleIndex'; path: string }
  | { id: number; type: 'getVisibleRows'; end: number; start: number }
  | { id: number; type: 'initialize'; options: BulkExperimentInitOptions }
  | { id: number; type: 'startIngest' };

export type BulkExperimentWorkerResponse =
  | { id: number; type: 'ack' }
  | { error: string; id: number; type: 'error' }
  | {
      id: number;
      index: number | null;
      type: 'visibleIndex';
    }
  | {
      id: number;
      rows: readonly BulkExperimentVisibleRow[];
      type: 'visibleRows';
    };

export interface BulkExperimentWorkerSnapshotMessage {
  snapshot: BulkExperimentSnapshot;
  type: 'snapshot';
}

export type BulkExperimentWorkerMessage =
  | BulkExperimentWorkerResponse
  | BulkExperimentWorkerSnapshotMessage;
