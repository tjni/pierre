import { preloadFileTree } from '@pierre/trees/ssr';

import { RevealLoadingDemoClient } from '../_demos/RevealLoadingDemoClient';
import { createPresortedPreparedInput } from '../_lib/createPresortedPreparedInput';
import { REVEAL_DEMO_ROOT_PATHS } from '../_lib/revealLoadingDemoData';
import { FILE_TREE_PROOF_VIEWPORT_HEIGHT } from '../_lib/workloadMeta';

export default function TreesDevRevealPage() {
  const mountId = 'trees-dev-reveal-demo';
  const payload = preloadFileTree({
    flattenEmptyDirectories: false,
    id: 'trees-dev-reveal-ssr',
    paths: REVEAL_DEMO_ROOT_PATHS,
    preparedInput: createPresortedPreparedInput(REVEAL_DEMO_ROOT_PATHS),
    search: true,
    viewportHeight: FILE_TREE_PROOF_VIEWPORT_HEIGHT,
  });

  return (
    <RevealLoadingDemoClient mountId={mountId} payloadHtml={payload.html} />
  );
}
