---
name: tooling-and-dependencies
description:
  Use when running repo scripts, adding or changing dependencies, editing
  package.json files, installing packages, or deciding how Bun workspace
  commands should be invoked in this monorepo.
---

# Tooling and Dependencies

## Bun

- Use `bun` exclusively for commands and package operations.
- Do not use `npm`, `pnpm`, `npx`, or other package runners unless there is a
  specific reason and you explain it.
- Bun can run TypeScript directly, so local scripts may be `.ts` files without a
  separate compile step.

## Dependency Catalog

This monorepo uses Bun's `workspaces.catalog` in the root `package.json`.

- Never add a version directly to an individual package's `package.json` by
  default.
- To add a dependency:
  1. Add the exact version to the root `package.json` under
     `workspaces.catalog`, for example `"new-package": "1.2.3"`.
  2. Reference it from the package with `"new-package": "catalog:"`.
- Do not run `bun add <package>` inside a package directory; it writes direct
  versions and breaks the catalog pattern.
- Published packages may intentionally use ranges for end-user compatibility.
  `apps/docs` should use catalog versions; published packages such as
  `packages/diffs` may use ranges only when that is intentional.

## Tasks

- All build/dev/test/lint entrypoints are moon tasks; package.json scripts exist
  only for npm lifecycle hooks (`prepublishOnly`). Never add task scripts back
  to a package.json.
- Tasks are defined in `.moon/tasks/*.yml` (inherited) and each project's
  `moon.yml`. Repo-wide tooling (format, lint, icons, clean) lives on the `root`
  project.
- Run tasks from anywhere in the repo:

```bash
moon run <project>:<task>
moonx <project>:<task>             # shorthand for moon exec
moonx <project>:<task> -- --flags  # forward arguments after --
moon run :test                     # a task across every project that has it
moon tasks <project>               # discover a project's tasks
```

moon builds dependency projects first (`deps: ['^:build']`), caches outputs, and
skips tasks whose inputs have not changed. Sessions must `unset CI` (see
AGENTS.md) or moon will refuse to run local-only tasks like dev servers and
formatters.
