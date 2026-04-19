import { getVirtualizationWorkload } from '@pierre/tree-test-data';
import { preloadFileTree } from '@pierre/trees/ssr';

import { BulkIngestDemoClient } from '../_demos/BulkIngestDemoClient';
import { createPresortedPreparedInput } from '../_lib/createPresortedPreparedInput';
import { FILE_TREE_PROOF_VIEWPORT_HEIGHT } from '../_lib/workloadMeta';

const BULK_PREVIEW_PATH_COUNT = 100;
const BULK_WORKLOAD_NAME = 'linux-5x';

export default function TreesDevBulkPage() {
  const mountId = 'trees-dev-bulk-demo';
  const workload = getVirtualizationWorkload(BULK_WORKLOAD_NAME);
  const previewPaths = workload.presortedFiles.slice(
    0,
    BULK_PREVIEW_PATH_COUNT
  );
  const payload = preloadFileTree({
    flattenEmptyDirectories: false,
    id: 'trees-dev-bulk-ssr',
    paths: previewPaths,
    preparedInput: createPresortedPreparedInput(previewPaths),
    search: true,
    viewportHeight: FILE_TREE_PROOF_VIEWPORT_HEIGHT,
  });

  return (
    <BulkIngestDemoClient
      mountId={mountId}
      payloadHtml={payload.html}
      previewPaths={previewPaths}
      totalPathCount={workload.presortedFiles.length}
      workloadLabel={workload.label}
      workloadName={BULK_WORKLOAD_NAME}
    />
  );
}
