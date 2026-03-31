import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

import { FileDiff, type FileDiffOptions } from '../../components/FileDiff';
import { VirtualizedFileDiff } from '../../components/VirtualizedFileDiff';
import type { GetHoveredLineResult } from '../../managers/InteractionManager';
import type {
  DiffDecorationItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
  VirtualFileMetrics,
} from '../../types';
import { areOptionsEqual } from '../../utils/areOptionsEqual';
import { noopRender } from '../constants';
import { useVirtualizer } from '../Virtualizer';
import { WorkerPoolContext } from '../WorkerPoolContext';
import { useStableCallback } from './useStableCallback';

const useIsometricEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

interface UseFileDiffInstanceProps<LAnnotation, LDecoration> {
  fileDiff: FileDiffMetadata;
  options: FileDiffOptions<LAnnotation, LDecoration> | undefined;
  lineAnnotations: DiffLineAnnotation<LAnnotation>[] | undefined;
  decorations: DiffDecorationItem<LDecoration>[] | undefined;
  selectedLines: SelectedLineRange | null | undefined;
  prerenderedHTML: string | undefined;
  metrics?: VirtualFileMetrics;
  hasGutterRenderUtility: boolean;
  hasCustomHeader: boolean;
  disableWorkerPool: boolean;
}

interface UseFileDiffInstanceReturn {
  ref(node: HTMLElement | null): void;
  getHoveredLine(): GetHoveredLineResult<'diff'> | undefined;
}

export function useFileDiffInstance<LAnnotation, LDecoration>({
  fileDiff,
  options,
  lineAnnotations,
  decorations,
  selectedLines,
  prerenderedHTML,
  metrics,
  hasGutterRenderUtility,
  hasCustomHeader,
  disableWorkerPool,
}: UseFileDiffInstanceProps<
  LAnnotation,
  LDecoration
>): UseFileDiffInstanceReturn {
  const simpleVirtualizer = useVirtualizer();
  const controlledSelection = selectedLines !== undefined;
  const poolManager = useContext(WorkerPoolContext);
  const instanceRef = useRef<
    | FileDiff<LAnnotation, LDecoration>
    | VirtualizedFileDiff<LAnnotation, LDecoration>
    | null
  >(null);
  const ref = useStableCallback((fileContainer: HTMLElement | null) => {
    if (fileContainer != null) {
      if (instanceRef.current != null) {
        throw new Error(
          'useFileDiffInstance: An instance should not already exist when a node is created'
        );
      }
      if (simpleVirtualizer != null) {
        instanceRef.current = new VirtualizedFileDiff(
          mergeFileDiffOptions({
            controlledSelection,
            hasCustomHeader,
            hasGutterRenderUtility,
            options,
          }),
          simpleVirtualizer,
          metrics,
          !disableWorkerPool ? poolManager : undefined,
          true
        );
      } else {
        instanceRef.current = new FileDiff(
          mergeFileDiffOptions({
            controlledSelection,
            hasCustomHeader,
            hasGutterRenderUtility,
            options,
          }),
          !disableWorkerPool ? poolManager : undefined,
          true
        );
      }
      void instanceRef.current.hydrate({
        fileDiff,
        fileContainer,
        lineAnnotations,
        decorations,
        prerenderedHTML,
      });
    } else {
      if (instanceRef.current == null) {
        throw new Error(
          'useFileDiffInstance: A FileDiff instance should exist when unmounting'
        );
      }
      instanceRef.current.cleanUp();
      instanceRef.current = null;
    }
  });

  useIsometricEffect(() => {
    const { current: instance } = instanceRef;
    if (instance == null) return;
    const newOptions = mergeFileDiffOptions({
      controlledSelection,
      hasCustomHeader,
      hasGutterRenderUtility,
      options,
    });
    const forceRender = !areOptionsEqual(instance.options, newOptions);
    instance.setOptions(newOptions);
    void instance.render({
      forceRender,
      fileDiff,
      lineAnnotations,
      decorations,
    });
    if (selectedLines !== undefined) {
      instance.setSelectedLines(selectedLines);
    }
  });

  const getHoveredLine = useCallback(():
    | GetHoveredLineResult<'diff'>
    | undefined => {
    return instanceRef.current?.getHoveredLine();
  }, []);

  return { ref, getHoveredLine };
}

interface MergeFileDiffOptionsProps<LAnnotation, LDecoration> {
  controlledSelection: boolean;
  hasCustomHeader: boolean;
  hasGutterRenderUtility: boolean;
  options: FileDiffOptions<LAnnotation, LDecoration> | undefined;
}

function mergeFileDiffOptions<LAnnotation, LDecoration>({
  options,
  controlledSelection,
  hasCustomHeader,
  hasGutterRenderUtility,
}: MergeFileDiffOptionsProps<LAnnotation, LDecoration>):
  | FileDiffOptions<LAnnotation, LDecoration>
  | undefined {
  if (!controlledSelection && !hasGutterRenderUtility && !hasCustomHeader) {
    return options;
  }
  return {
    ...options,
    controlledSelection,
    renderCustomHeader: hasCustomHeader
      ? noopRender
      : options?.renderCustomHeader,
    renderGutterUtility: hasGutterRenderUtility
      ? noopRender
      : options?.renderGutterUtility,
  };
}
