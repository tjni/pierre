# Autoresearch Ideas

## Deferred optimizations for path-store presorted first render

### Done / tried
- ✅ **Eliminate `directories.get()` in backward pass** — kept, saved ~1.3ms
- ❌ **Remove `node.id` field** — tried, profile was flat (110.7ms vs 110.6ms). V8 allocation cost doesn't scale with property count in 9-10 range.
- ❌ **Skip `visibleSubtreeCount` in backward pass** — tried, savings (~1.4ms) below noise floor
- ❌ **Make `initializeOpenVisibleCounts` non-recursive** — tried, caused massive Bun regression (73→265ms). Bun strongly prefers recursion.

### Still promising
- **Replace `directories` Map with flat array**: Use `directoryIndexCache[nodeId]` for forward/backward passes. May save Map overhead on ~100K lookups. But sparse array in V8 uses dictionary mode.

- **Pre-size `nodes` array**: Use `paths.length * 2` to avoid ~20-30 dynamic array resizes. Estimated ~2.8ms savings.

- **Trie-based segment interning**: Avoid `path.slice()` by traversing a char trie instead of hash lookup. Complex but eliminates ~700K string allocations for existing segments.

- **Single flat `childIds` array**: Replace ~100K separate `childIds` arrays with one pre-allocated flat array + start/end indices. Eliminates ~100K array allocations.

- **Batch `Map` construction**: Use `new Map(entries)` in `ensureChildIdByNameId` for bulk construction.

- **Inline `internSegment` into presorted loop**: Avoid function call overhead for ~700K calls. The hot path (existing segment) is just one property access — could be inlined as a direct property read.

- **Convert `for...of` loops in other hot paths**: Already helped initializeOpenVisibleCounts significantly (-4.9% profile). Check other frequently called functions.

- **Avoid `path.substring(0, segmentStart)` allocation in cache update**: Only allocate when directory changes, but for the first path in a new directory, the allocation is unavoidable.
