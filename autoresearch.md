# Autoresearch: path-store presorted first render

## Objective

Optimize the real `@pierre/path-store` presorted 0→1 render path represented by:

- `bun ws path-store benchmark -- --preset presorted-render`

The benchmark preset currently measures two component scenarios against the
`linux-5x` workload:

- `build/linux-5x`
- `visible-first/linux-5x/30`

and the main optimization target is the derived summary that sums those two
measured components:

- `equivalent-presorted-warm-first-render/linux-5x/30`

This is the best primary metric because it matches the intended workload: start
from a presorted path array, build the store, and render the first visible 30
rows.

The nearby truth-check is:

- `bun ws path-store profile:demo -- --runs 5`

That command profiles the same rough flow in the browser and exposes phase
timings. Use it whenever a benchmark win looks suspiciously large or when code
changes might have moved work outside the benchmark boundary. If benchmark
numbers improve dramatically but `profile:demo` does not, treat that as a likely
measurement mistake until proven otherwise.

## Metrics

- **Primary**: `presorted_first_render_p50_ms` (ms, lower is better) — p50 of
  `equivalent-presorted-warm-first-render/linux-5x/30`
- **Secondary**:
  - `presorted_first_render_p95_ms`
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
- Baseline benchmark via `./autoresearch.sh`:
  - `build/linux-5x` p50 = `501.940 ms`, p95 = `506.895 ms`
  - `visible-first/linux-5x/30` p50 = `0.001459 ms`, p95 = `0.002250 ms`
  - `equivalent-presorted-warm-first-render/linux-5x/30` p50 = `501.942 ms`, p95
    = `506.897 ms`
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
- Early read-through notes:
  - The first-render target is overwhelmingly dominated by build time, not the
    visible-window read itself.
  - The builder plus initial count recomputation are the likely primary hot
    path; `visible-first` itself is already effectively free compared with
    build.
  - Use `profile:demo` to confirm whether future wins are real improvements to
    store creation/count repair rather than work moving outside the benchmarked
    region.
