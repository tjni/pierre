# Autoresearch Ideas

## Deferred optimizations for path-store presorted first render

- **Eliminate `directories.get()` in backward pass**: Move `totalChildSubtreeNodeCount` computation from `buildPresortedFinish` backward pass into `initializeOpenVisibleCounts` (which already iterates all directory children). Saves ~700K Map.get calls at the cost of ~700K property reads. Estimated net ~4ms savings.

- **Replace `directories` Map with flat array**: Use `directoryIndexCache[nodeId]` instead of `directories.get(nodeId)` for the forward/backward passes. Saves Map overhead but creates a sparse array (~100K entries in ~700K slots).

- **Remove `node.id` field**: The `id` is always the array index. Removing it saves one property per ~700K node allocations. Requires updating all `node.id` references across the codebase to use the array index variable instead.

- **Pre-size `nodes` array**: Use `paths.length * 2` as estimate to avoid ~20-30 dynamic array resizes during construction. Saves ~2.8ms of element copying.

- **Trie-based segment interning**: Avoid `path.slice()` string allocation by traversing a character trie instead of doing property lookup with a substring key. Complex implementation but eliminates ~700K string allocations for existing segments.

- **Make `initializeOpenVisibleCounts` non-recursive**: Convert the recursive descent to a linear backward pass (similar to how `computeSubtreeCounts` was linearized). Saves recursion overhead for ~700K nodes.

- **Single flat `childIds` array**: Instead of ~100K separate `childIds` arrays (one per directory), use a single pre-allocated flat array with start/end indices per directory. Eliminates ~100K array allocations and improves cache locality.

- **Batch `Map` construction**: Use `new Map(entries)` for `childIdByNameId` in `ensureChildIdByNameId` to let V8 optimize bulk construction vs incremental `set()` calls.

- **Skip `visibleSubtreeCount` accumulation in backward pass**: Since state initialization always overwrites `visibleSubtreeCount`, the backward pass can skip accumulating it into parent nodes. Saves ~700K additions.
