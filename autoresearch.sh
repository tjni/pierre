#!/bin/bash
set -euo pipefail

export AGENT=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BENCHMARK_JSON="$(mktemp)"
BENCHMARK_ERR="$(mktemp)"
PROFILE_JSON=""
PROFILE_ERR=""
MUTATION_JSON=""
MUTATION_ERR=""

cleanup() {
  rm -f "$BENCHMARK_JSON" "$BENCHMARK_ERR"
  if [[ -n "$PROFILE_JSON" ]]; then
    rm -f "$PROFILE_JSON"
  fi
  if [[ -n "$PROFILE_ERR" ]]; then
    rm -f "$PROFILE_ERR"
  fi
  if [[ -n "$MUTATION_JSON" ]]; then
    rm -f "$MUTATION_JSON"
  fi
  if [[ -n "$MUTATION_ERR" ]]; then
    rm -f "$MUTATION_ERR"
  fi
}
trap cleanup EXIT

# Fast syntax/import prechecks before paying the full benchmark cost.
bun ws path-store benchmark -- --help >/dev/null 2>&1
bun ws path-store profile:demo -- --help >/dev/null 2>&1

PROFILE_JSON="$(mktemp)"
PROFILE_ERR="$(mktemp)"
if ! bun ws path-store profile:demo -- --runs 5 --json >"$PROFILE_JSON" 2>"$PROFILE_ERR"; then
  tail -80 "$PROFILE_ERR" >&2
  exit 1
fi

bun -e '
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function formatMetric(value) {
  return Number(value).toFixed(6);
}

const profilePath = process.argv[1];
const output = JSON.parse(readFileSync(profilePath, "utf8"));
const scenario = output.scenarios?.find(
  (entry) =>
    entry?.scenario?.workload?.name === "linux-5x" &&
    entry?.scenario?.action?.id === "render"
);
if (scenario == null) {
  fail("Missing linux-5x/render profile scenario.");
}

const visibleRowsReady = scenario.summary?.metrics?.visibleRowsReadyMs;
const postPaintReady = scenario.summary?.metrics?.postPaintReadyMs;
if (visibleRowsReady == null || postPaintReady == null) {
  fail("Missing profile aggregate metrics.");
}

console.log(
  `primary target: profile demo visible rows median=${visibleRowsReady.medianMs?.toFixed(3) ?? "n/a"} ms p95=${visibleRowsReady.p95Ms?.toFixed(3) ?? "n/a"} ms, post-paint median=${postPaintReady.medianMs?.toFixed(3) ?? "n/a"} ms p95=${postPaintReady.p95Ms?.toFixed(3) ?? "n/a"} ms`
);

if (visibleRowsReady.medianMs != null) {
  console.log(`METRIC profile_visible_rows_ready_median_ms=${formatMetric(visibleRowsReady.medianMs)}`);
}
if (visibleRowsReady.p95Ms != null) {
  console.log(`METRIC profile_visible_rows_ready_p95_ms=${formatMetric(visibleRowsReady.p95Ms)}`);
}
if (postPaintReady.medianMs != null) {
  console.log(`METRIC profile_post_paint_ready_median_ms=${formatMetric(postPaintReady.medianMs)}`);
}
if (postPaintReady.p95Ms != null) {
  console.log(`METRIC profile_post_paint_ready_p95_ms=${formatMetric(postPaintReady.p95Ms)}`);
}
' "$PROFILE_JSON"

if ! bun ws path-store benchmark -- --preset full --filter '^(prepare-presorted-input/linux-5x|build/linux-5x|visible-first/linux-5x/30)$' --json >"$BENCHMARK_JSON" 2>"$BENCHMARK_ERR"; then
  tail -80 "$BENCHMARK_ERR" >&2
  exit 1
fi

bun -e '
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function nsToMs(value) {
  return value / 1_000_000;
}

function formatMetric(value) {
  return Number(value).toFixed(6);
}

function formatHumanMs(value) {
  return `${nsToMs(value).toFixed(3)} ms`;
}

const benchmarkPath = process.argv[1];
const run = JSON.parse(readFileSync(benchmarkPath, "utf8"));
const derived = run.derivedSummaries?.find(
  (summary) => summary.name === "equivalent-presorted-first-render/linux-5x/30"
);
if (derived == null) {
  fail(
    `Missing derived summary. Available summaries: ${JSON.stringify(
      run.derivedSummaries?.map((summary) => summary.name) ?? []
    )}`
  );
}

const benchmarkByAlias = new Map(
  (run.results?.benchmarks ?? []).map((benchmark) => [
    benchmark.alias,
    benchmark.runs?.[0]?.stats ?? null,
  ])
);
const prepare = benchmarkByAlias.get("prepare-presorted-input/linux-5x");
const build = benchmarkByAlias.get("build/linux-5x");
const visible = benchmarkByAlias.get("visible-first/linux-5x/30");
if (prepare == null || build == null || visible == null) {
  fail(
    `Missing component stats. Available benchmarks: ${JSON.stringify(
      [...benchmarkByAlias.keys()]
    )}`
  );
}

console.log(
  `benchmark monitor: ${derived.name} p50=${formatHumanMs(derived.stats.p50)} p95=${formatHumanMs(derived.stats.p95)}`
);
console.log(
  `benchmark components: prepare p50=${formatHumanMs(prepare.p50)} p95=${formatHumanMs(prepare.p95)}, build p50=${formatHumanMs(build.p50)} p95=${formatHumanMs(build.p95)}, visible-first p50=${formatHumanMs(visible.p50)} p95=${formatHumanMs(visible.p95)}`
);

console.log(`METRIC presorted_full_first_render_p50_ms=${formatMetric(nsToMs(derived.stats.p50))}`);
console.log(`METRIC presorted_full_first_render_p95_ms=${formatMetric(nsToMs(derived.stats.p95))}`);
console.log(`METRIC prepare_presorted_input_p50_ms=${formatMetric(nsToMs(prepare.p50))}`);
console.log(`METRIC prepare_presorted_input_p95_ms=${formatMetric(nsToMs(prepare.p95))}`);
console.log(`METRIC build_p50_ms=${formatMetric(nsToMs(build.p50))}`);
console.log(`METRIC build_p95_ms=${formatMetric(nsToMs(build.p95))}`);
console.log(`METRIC visible_first_p50_ms=${formatMetric(nsToMs(visible.p50))}`);
console.log(`METRIC visible_first_p95_ms=${formatMetric(nsToMs(visible.p95))}`);
' "$BENCHMARK_JSON"

if [[ "${AUTORESEARCH_MUTATION_GUARD:-0}" == "1" ]]; then
  MUTATION_JSON="$(mktemp)"
  MUTATION_ERR="$(mktemp)"
  if ! bun ws path-store benchmark -- --preset mutation --filter '^(mutate/rename-leaf/first/linux-5x/200|mutate/rename-root-directory/first/linux-5x/200)$' --json >"$MUTATION_JSON" 2>"$MUTATION_ERR"; then
    tail -80 "$MUTATION_ERR" >&2
    exit 1
  fi

  bun -e '
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function nsToMs(value) {
  return value / 1_000_000;
}

function formatMetric(value) {
  return Number(value).toFixed(6);
}

function formatHumanMs(value) {
  return `${nsToMs(value).toFixed(3)} ms`;
}

const mutationPath = process.argv[1];
const run = JSON.parse(readFileSync(mutationPath, "utf8"));
const benchmarkByAlias = new Map(
  (run.results?.benchmarks ?? []).map((benchmark) => [
    benchmark.alias,
    benchmark.runs?.[0]?.stats ?? null,
  ])
);
const renameLeaf = benchmarkByAlias.get("mutate/rename-leaf/first/linux-5x/200");
const renameRootDirectory = benchmarkByAlias.get(
  "mutate/rename-root-directory/first/linux-5x/200"
);
if (renameLeaf == null || renameRootDirectory == null) {
  fail(
    `Missing mutation guardrail stats. Available benchmarks: ${JSON.stringify(
      [...benchmarkByAlias.keys()]
    )}`
  );
}

console.log(
  `mutation guardrail: rename-leaf p50=${formatHumanMs(renameLeaf.p50)} p95=${formatHumanMs(renameLeaf.p95)}, rename-root-directory p50=${formatHumanMs(renameRootDirectory.p50)} p95=${formatHumanMs(renameRootDirectory.p95)}`
);

console.log(`METRIC rename_leaf_p50_ms=${formatMetric(nsToMs(renameLeaf.p50))}`);
console.log(`METRIC rename_leaf_p95_ms=${formatMetric(nsToMs(renameLeaf.p95))}`);
console.log(`METRIC rename_root_directory_p50_ms=${formatMetric(nsToMs(renameRootDirectory.p50))}`);
console.log(`METRIC rename_root_directory_p95_ms=${formatMetric(nsToMs(renameRootDirectory.p95))}`);
' "$MUTATION_JSON"
fi
