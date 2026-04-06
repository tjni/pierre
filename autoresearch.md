# Autoresearch: path-store presorted first render

## Objective

Optimize the real `@pierre/path-store` presorted 0→1 render path represented by:

- `bun ws path-store benchmark -- --preset full --filter '^(prepare-presorted-input/linux-5x|build/linux-5x|visible-first/linux-5x/30)$'`

The benchmark command used by the autoresearch loop measures three component
scenarios against the `linux-5x` workload:

- `prepare-presorted-input/linux-5x`
- `build/linux-5x`
- `visible-first/linux-5x/30`

and the main optimization target is the derived summary that sums those three
measured components:

- `equivalent-presorted-first-render/linux-5x/30`

This is the best primary metric because it matches the intended workload more
closely than the earlier warm-start target: start from a presorted string array,
prepare the input object, build the store, and render the first visible 30 rows.

The nearby truth-check is:

- `bun ws path-store profile:demo -- --runs 5`

That command profiles the same rough flow in the browser and exposes phase
timings. Use it whenever a benchmark win looks suspiciously large or when code
changes might have moved work outside the benchmark boundary. If benchmark
numbers improve dramatically but `profile:demo` does not, treat that as a likely
measurement mistake until proven otherwise.

## Metrics

- **Primary**: `presorted_full_first_render_p50_ms` (ms, lower is better) — p50
  of `equivalent-presorted-first-render/linux-5x/30`
- **Secondary**:
  - `presorted_full_first_render_p95_ms`
  - `prepare_presorted_input_p50_ms`
  - `prepare_presorted_input_p95_ms`
  - `build_p50_ms`
  - `build_p95_ms`
  - `visible_first_p50_ms`
  - `visible_first_p95_ms`
  - optional truth-check metrics when `AUTORESEARCH_PROFILE_DEMO=1`:
    - `profile_visible_rows_ready_median_ms`
    - `profile_visible_rows_ready_p95_ms`
    - `profile_post_paint_ready_median_ms`
    - `profile_post_paint_ready_p95_ms`
  - optional mutation guardrail metrics when `AUTORESEARCH_MUTATION_GUARD=1`:
    - `rename_leaf_p50_ms`
    - `rename_leaf_p95_ms`
    - `rename_root_directory_p50_ms`
    - `rename_root_directory_p95_ms`

Mutation metrics are a **soft monitor**, not a hard gate. The goal is to avoid
accidental regressions where first-render wins are purchased by turning
interactive mutations from sub-millisecond into tens or hundreds of
milliseconds.

## How to Run

Primary loop command:

```bash
./autoresearch.sh
```

Optional truth-check / guardrail modes:

```bash
AUTORESEARCH_PROFILE_DEMO=1 ./autoresearch.sh
AUTORESEARCH_MUTATION_GUARD=1 ./autoresearch.sh
AUTORESEARCH_PROFILE_DEMO=1 AUTORESEARCH_MUTATION_GUARD=1 ./autoresearch.sh
```

Correctness checks run through:

```bash
./autoresearch.checks.sh
```

## Files in Scope

- `packages/path-store/src/store.ts` — constructor path, public read APIs, and
  benchmark instrumentation boundaries
- `packages/path-store/src/builder.ts` — presorted ingest builder hot path
- `packages/path-store/src/canonical.ts` — canonical topology mutations, path
  materialization, count repair
- `packages/path-store/src/projection.ts` — visible count and first-window
  selection/materialization
- `packages/path-store/src/child-index.ts` — child visible-count lookup for cold
  visible selection
- `packages/path-store/src/flatten.ts` — flatten-empty-directory projection
  logic used by first rows
- `packages/path-store/src/state.ts` — expansion state and cache invalidation
  bookkeeping
- `packages/path-store/src/cleanup.ts` — cleanup behavior if memory/cache work
  touches first-render tradeoffs
- `packages/path-store/src/static-store.ts` — useful reference if a mutable-path
  optimization can borrow a read-side idea
- `packages/path-store/src/internal/benchmarkInstrumentation.ts` —
  instrumentation hooks surfaced by `profile:demo`
- `packages/path-store/scripts/benchmark.ts` — benchmark preset wiring and
  derived summary reporting; instrumentation changes are allowed, measurement
  narrowing is not
- `packages/path-store/scripts/profileDemo.ts` — browser profiling harness for
  hotspot inspection and truth-checking
- `packages/path-store/test/**` — correctness coverage and benchmark-script
  tests

## Off Limits

- Any change whose main effect is to measure less work instead of making the
  real workload faster
- Ingesting fewer paths, rendering fewer real rows, or otherwise shrinking the
  workload while still claiming the same benchmark win
- Changing `presorted-render` or `profile:demo` semantics in a way that hides
  work outside the measured section
- Repo-wide dependency changes unless absolutely necessary (they should not be
  necessary here)

## Constraints

- Keep wins grounded in real user-facing performance, not benchmark tricks
- Use `profile:demo` to validate suspiciously large benchmark improvements
- Lint, typecheck, and `packages/path-store` tests must pass before keeping a
  result
- Use `bun`, not `npm`/`pnpm`
- Prefer localized hot-path improvements over broad architectural churn unless
  profiling clearly justifies larger changes
- Internal behavior changes are allowed; external behavior changes are allowed
  only when justified and still aligned with the workload goal

## What's Been Tried

- Baseline setup completed on branch
  `autoresearch/path-store-presorted-render-2026-04-06`.
- Original warm-start benchmark baseline via `./autoresearch.sh` before the
  target correction:
  - `build/linux-5x` p50 = `501.940 ms`, p95 = `506.895 ms`
  - `visible-first/linux-5x/30` p50 = `0.001459 ms`, p95 = `0.002250 ms`
  - `equivalent-presorted-warm-first-render/linux-5x/30` p50 = `501.942 ms`, p95
    = `506.897 ms`
- Target correction after user review:
  - The profile truth-check includes `page.preparePresortedInput`, but the old
    warm-start benchmark target did not include `prepare-presorted-input`.
  - The loop now uses the fuller benchmark target
    `equivalent-presorted-first-render/linux-5x/30` so benchmark percentages
    line up more honestly with `profile:demo`.
  - New corrected baseline on current code:
    - `prepare-presorted-input/linux-5x` p50 = `78.513 ms`, p95 = `85.899 ms`
    - `build/linux-5x` p50 = `70.542 ms`, p95 = `73.703 ms`
    - `visible-first/linux-5x/30` p50 = `0.001459 ms`, p95 = `0.004042 ms`
    - `equivalent-presorted-first-render/linux-5x/30` p50 = `149.057 ms`, p95 =
      `159.606 ms`
    - `profile:demo` visible rows ready median = `246.8 ms`, post-paint ready
      median = `247.9 ms`
- Attempt 7 (candidate to keep against the corrected full metric): make segment
  sort keys lazy in `internSegment()` so presorted bulk ingest no longer pays to
  precompute natural-sort metadata for every unique segment.
  - Full-metric benchmark result: `147.046 ms` p50 / `152.294 ms` p95 on
    `equivalent-presorted-first-render/linux-5x/30` (~1.3% faster than the
    corrected full baseline).
  - Component movement:
    - `prepare-presorted-input` regressed slightly: `78.513 ms` → `79.374 ms`
    - `build` improved more: `70.542 ms` → `67.671 ms`
  - Matching `profile:demo` truth-check also improved:
    - visible rows ready median: `246.8 ms` → `235.7 ms`
    - post-paint ready median: `247.9 ms` → `236.7 ms`
  - Interpretation: lazy sort keys help the real end-to-end flow because build
    pays less upfront for segment metadata. The browser win is larger than the
    benchmark win because Chrome seems to benefit more on this path than Bun.
- Attempt 8 (candidate to keep): replace `splitCanonicalPath()`'s
  slice-then-split path parser with a single-pass manual scanner.
  - Full-metric benchmark result: `142.661 ms` p50 / `172.926 ms` p95 on
    `equivalent-presorted-first-render/linux-5x/30` (~4.3% faster than the
    corrected full baseline, ~3.0% faster than Attempt 7).
  - Component movement:
    - `prepare-presorted-input` improved sharply: `79.374 ms` → `36.007 ms`
    - `build` regressed: `67.671 ms` → `106.653 ms`
  - Matching `profile:demo` truth-check improved only slightly:
    - visible rows ready median: `235.7 ms` → `233.8 ms`
    - post-paint ready median: `236.7 ms` → `234.9 ms`
  - Interpretation: this appears to trade a much faster prepare step for a
    slower build step, probably because the new segment strings are cheaper to
    parse up front but less friendly for later build-time interning/hash work.
    It is still a real full-metric win, but it is less attractive than the
    earlier changes because the browser truth-check moved less than the prepare
    step and build remained slower.
  - Validation rerun on unchanged code was stronger than the first sample:
    - full metric: `138.742 ms` p50 / `159.340 ms` p95
    - visible rows ready median: `230.9 ms`
    - This confirmed the change is likely real despite the uneven prepare/build
      tradeoff.
- Attempt 9 (reverted by `discard`): try a hybrid parser that keeps `split('/')`
  but avoids the extra pre-split trailing-slash slice by splitting the original
  string and popping the trailing empty segment.
  - Result: `150.369 ms` p50 / `155.985 ms` p95 on the full metric, plus
    `profile:demo` visible rows ready median `237.0 ms`.
  - Conclusion: this recovered the earlier faster build shape but gave back too
    much prepare time, so it was worse than the current best manual parser.
- Attempt 10 (candidate to keep): keep the manual parser, but add a trusted
  builder fast path that skips per-child collision lookups when ingesting
  already-prepared canonical input.
  - Full-metric benchmark result: `137.445 ms` p50 / `153.935 ms` p95 on
    `equivalent-presorted-first-render/linux-5x/30` (~7.8% faster than the
    corrected full baseline, ~0.9% faster than the current best validation
    sample).
  - Component movement:
    - `prepare-presorted-input` stayed effectively flat: `35.950 ms` →
      `35.825 ms`
    - `build` improved slightly: `102.791 ms` → `101.619 ms`
  - Matching `profile:demo` was basically flat within noise:
    - visible rows ready median: `230.9 ms` → `232.8 ms`
    - visible rows ready p95: `235.42 ms` → `233.08 ms`
  - Interpretation: this likely trims a little more Bun-side builder overhead,
    but the browser truth-check is close enough to treat it as noise-level on
    the Chrome path.
- Attempt 12 (reverted by `discard`): defer `childIdByNameId` and
  `childPositionById` map population until builder `finish()` for the trusted
  prepared-input fast path.
  - Result: `141.515 ms` p50 / `162.820 ms` p95 on the full metric.
  - It kept prepare very fast and even nudged the browser profile a bit lower,
    but Bun build got slower enough that the primary metric lost to the current
    best.
  - Conclusion: rebuilding the directory lookup maps in a second pass is not
    worth it. The per-child `Map.set()` cost is cheaper than the deferred full
    rebuild for this workload.
- Attempt 13 (candidate to keep): replace the segment table's string→id `Map`
  with a null-prototype object for direct property lookup.
  - Result: `127.239 ms` p50 / `144.315 ms` p95 on the full metric.
  - Component movement:
    - `prepare-presorted-input` was essentially flat: `35.825 ms` → `36.203 ms`
    - `build` improved materially: `101.619 ms` → `91.034 ms`
  - Matching `profile:demo` truth-check stayed in-family:
    - visible rows ready median: `232.8 ms` → `230.9 ms`
    - visible rows ready p95: `233.08 ms` → `235.62 ms` (roughly flat/noisy)
  - Interpretation: the main win is cheaper segment interning / lookup during
    build. Chrome benefits less than Bun, but the full metric gain is large
    enough to keep.
- Attempt 11 (reverted by `discard`): precompute each prepared path's shared
  directory depth with the previous entry during prepare, then let the builder
  reuse that metadata instead of recomputing shared-prefix depth.
  - Result: `142.327 ms` p50 / `159.182 ms` p95 on the full metric.
  - It improved build (`101.619 ms` → `78.714 ms`) but gave back too much on
    prepare (`35.825 ms` → `63.612 ms`), so it lost to the current best full
    metric.
  - Conclusion: shifting shared-prefix work into prepare is not worthwhile for
    this combined metric; the current best favors the very fast manual prepare
    path even if build stays somewhat slower.
- Baseline checks passed:
  - `bun run lint`
  - `cd packages/path-store && bun run tsc`
  - `cd packages/path-store && bun test`
- Attempt 1 (reverted by `checks_failed`): specialized constructor fast path for
  `initialExpansion: 'open'` that initialized visible counts without rerunning
  the generic full-tree count-repair walk.
  - Benchmark result before revert: `473.521 ms` p50 / `477.416 ms` p95 on
    `equivalent-presorted-warm-first-render/linux-5x/30` (~5.7% faster than
    baseline).
  - The failure was not a benchmark regression. A newly added test fixture used
    a path array that was not actually sorted for `preparePresortedInput()`, so
    checks failed for the test, not for the optimization idea itself.
- Attempt 2 (candidate to keep): reapply the open-startup visible-count fast
  path, plus a corrected regression test that compares prepared-input startup
  with the generic presorted constructor path under open+flattened visibility.
  - Benchmark result: `474.797 ms` p50 / `481.526 ms` p95 on
    `equivalent-presorted-warm-first-render/linux-5x/30` (~5.4% faster than
    baseline).
  - Matching `profile:demo` truth-check also improved materially:
    - visible rows ready median: `601.7 ms` → `414.7 ms`
    - post-paint ready median: `602.8 ms` → `415.8 ms`
  - Interpretation: this is a real first-render improvement, not a benchmark
    boundary trick. The saved work comes from avoiding the generic startup
    visible-count recomputation when the constructor already knows every
    directory starts open and there are no explicit expansion overrides.
  - Mutation guardrail spot-check after the keep:
    - `rename-leaf` p50 ≈ `0.013 ms`, p95 ≈ `0.023 ms`
    - `rename-root-directory` p50 ≈ `0.747 ms`, p95 ≈ `0.796 ms`
    - Conclusion: startup optimization did not obviously damage representative
      mutation latency.
- Attempt 3 (candidate to keep): replace `splitIntoNaturalTokens()`'s
  `matchAll()` iterator loop with a simpler `RegExp.exec()` loop.
  - Benchmark result: `165.320 ms` p50 / `169.113 ms` p95 on
    `equivalent-presorted-warm-first-render/linux-5x/30` (~67.1% faster than
    baseline, ~65.2% faster than Attempt 2).
  - Matching `profile:demo` truth-check also improved, but much less
    dramatically:
    - visible rows ready median: `414.7 ms` → `360.2 ms`
    - post-paint ready median: `415.8 ms` → `361.2 ms`
  - Interpretation: the win appears real, but it is runtime-sensitive. Bun
    benefits much more than Chrome from the tokenization rewrite. Follow-up
    profiling should inspect `page.createStore`/builder phase deltas to confirm
    how much of the gain is builder-order validation overhead vs. broader sort
    key creation work.
- Attempt 4 (candidate to keep): replace the remaining regex-based digit walk in
  `splitIntoNaturalTokens()` with a manual char-code scanner.
  - Benchmark result: `141.605 ms` p50 / `146.730 ms` p95 on
    `equivalent-presorted-warm-first-render/linux-5x/30` (~71.8% faster than
    baseline, ~14.3% faster than Attempt 3).
  - Matching `profile:demo` truth-check still improved, though modestly:
    - visible rows ready median: `360.2 ms` → `354.2 ms`
    - post-paint ready median: `361.2 ms` → `355.7 ms`
  - Interpretation: the manual scan continues to help the same natural-sort hot
    path, but the biggest gains are still Bun-specific. This is likely a valid
    benchmark win because the browser truth-check also moved in the right
    direction, just by a smaller amount.
- Attempt 5 (candidate to keep): cache segment sort keys while validating the
  monotonic order of prepared paths inside the builder.
  - Benchmark result: `116.206 ms` p50 / `117.809 ms` p95 on
    `equivalent-presorted-warm-first-render/linux-5x/30` (~76.8% faster than
    baseline, ~17.9% faster than Attempt 4).
  - Matching `profile:demo` truth-check improved more materially this time:
    - visible rows ready median: `354.2 ms` → `331.1 ms`
    - post-paint ready median: `355.7 ms` → `332.2 ms`
  - Interpretation: repeated segment-token creation during builder order
    validation was still a major constructor cost. Reusing cached sort keys in
    that validation path helps both Bun and Chrome.
- Attempt 6 (candidate to keep): trust `preparedInput` enough to skip the
  builder's redundant monotonic-order validation, while still rejecting exact
  duplicate paths.
  - Benchmark result: `73.756 ms` p50 / `74.630 ms` p95 on
    `equivalent-presorted-warm-first-render/linux-5x/30` (~85.3% faster than
    baseline, ~36.5% faster than Attempt 5).
  - Matching `profile:demo` truth-check improved substantially too:
    - visible rows ready median: `331.1 ms` → `256.9 ms`
    - post-paint ready median: `332.2 ms` → `257.9 ms`
  - Interpretation: for the explicit `preparedInput` fast path, re-validating
    canonical order inside the builder was a major chunk of startup cost. This
    is a real workload win, not a benchmark trick, because the browser profile
    moved strongly in the same direction.
  - Post-keep verification after user concern about benchmark drift:
    - Bun-side constructor instrumentation on current HEAD (same measured region
      as the benchmark's build scenario) reports roughly:
      - total constructor + first read median: `85.5 ms`
      - `store.builder.appendPreparedPaths` median: `71.9 ms`
      - `store.builder.computeSubtreeCounts` median: `5.9 ms`
      - `store.state.initializeOpenVisibleCounts` median: `4.5 ms`
    - Current browser `profile:demo` still shows matching directional wins:
      - `page.createStore` median ≈ `174.7 ms`
      - visible rows ready median ≈ `256.9 ms`
    - Conclusion: Bun benefits much more than Chrome from these changes, but the
      benchmark is still measuring the same constructor work. The only mismatch
      was that the old primary target excluded `prepare-presorted-input`, which
      is now corrected in the loop.
- Early read-through notes:
  - The first-render target is overwhelmingly dominated by build time, not the
    visible-window read itself.
  - The builder plus initial count recomputation are the likely primary hot
    path; `visible-first` itself is already effectively free compared with
    build.
  - Use `profile:demo` to confirm whether future wins are real improvements to
    store creation/count repair rather than work moving outside the benchmarked
    region.
