import type { ReactNode } from 'react';

import {
  CUSTOM_HEADER_SLOT_ID,
  HEADER_METADATA_SLOT_ID,
  HEADER_PREFIX_SLOT_ID,
} from '../../constants';
import type { GetHoveredLineResult } from '../../managers/InteractionManager';
import type { FileContents } from '../../types';
import { getLineAnnotationName } from '../../utils/getLineAnnotationName';
import { GutterUtilitySlotStyles } from '../constants';
import type { FileProps } from '../types';

interface RenderFileChildrenProps<LAnnotation, LDecoration> {
  file: FileContents;
  renderCustomHeader: FileProps<LAnnotation, LDecoration>['renderCustomHeader'];
  renderHeaderPrefix: FileProps<LAnnotation, LDecoration>['renderHeaderPrefix'];
  renderHeaderMetadata: FileProps<
    LAnnotation,
    LDecoration
  >['renderHeaderMetadata'];
  renderAnnotation: FileProps<LAnnotation, LDecoration>['renderAnnotation'];
  lineAnnotations: FileProps<LAnnotation, LDecoration>['lineAnnotations'];
  renderGutterUtility: FileProps<
    LAnnotation,
    LDecoration
  >['renderGutterUtility'];
  getHoveredLine(): GetHoveredLineResult<'file'> | undefined;
}

export function renderFileChildren<LAnnotation, LDecoration>({
  file,
  renderCustomHeader,
  renderHeaderPrefix,
  renderHeaderMetadata,
  renderAnnotation,
  lineAnnotations,
  renderGutterUtility,
  getHoveredLine,
}: RenderFileChildrenProps<LAnnotation, LDecoration>): ReactNode {
  const customHeader = renderCustomHeader?.(file);
  const prefix = renderHeaderPrefix?.(file);
  const metadata = renderHeaderMetadata?.(file);
  return (
    <>
      {customHeader != null ? (
        <div slot={CUSTOM_HEADER_SLOT_ID}>{customHeader}</div>
      ) : (
        <>
          {prefix != null && <div slot={HEADER_PREFIX_SLOT_ID}>{prefix}</div>}
          {metadata != null && (
            <div slot={HEADER_METADATA_SLOT_ID}>{metadata}</div>
          )}
        </>
      )}
      {renderAnnotation != null &&
        lineAnnotations?.map((annotation, index) => (
          <div key={index} slot={getLineAnnotationName(annotation)}>
            {renderAnnotation(annotation)}
          </div>
        ))}
      {renderGutterUtility != null && (
        <div slot="gutter-utility-slot" style={GutterUtilitySlotStyles}>
          {renderGutterUtility(getHoveredLine)}
        </div>
      )}
    </>
  );
}
