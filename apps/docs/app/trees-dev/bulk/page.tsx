import { preloadFileTree } from '@pierre/trees/ssr';

import { BulkIngestDemoClient } from '../_demos/BulkIngestDemoClient';
import { AOSP_PREVIEW_PATHS } from '../_lib/aospPreview';
import { createPresortedPreparedInput } from '../_lib/createPresortedPreparedInput';
import { FILE_TREE_PROOF_VIEWPORT_HEIGHT } from '../_lib/workloadMeta';

export default function TreesDevBulkPage() {
  const mountId = 'trees-dev-bulk-demo';
  const payload = preloadFileTree({
    flattenEmptyDirectories: false,
    id: 'trees-dev-bulk-ssr',
    paths: AOSP_PREVIEW_PATHS,
    preparedInput: createPresortedPreparedInput(AOSP_PREVIEW_PATHS),
    search: true,
    viewportHeight: FILE_TREE_PROOF_VIEWPORT_HEIGHT,
  });

  return <BulkIngestDemoClient mountId={mountId} payloadHtml={payload.html} />;
}
