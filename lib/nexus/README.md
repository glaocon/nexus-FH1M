# `lib/nexus/` — Nexus Runtime Core

This is the heart of Nexus: the TypeScript modules that own the canonical
lifecycle (discover → frame → plan → handoff → build → review → qa → ship →
closeout), the governed state model, host adapters, and the helper
primitives every skill prose ultimately compiles down to.

## Reading this directory

Two pieces help you find what you need:

1. The **subdirectories** below — each holds a single concern (lifecycle
   commands, host adapters, stage packs, etc.).
2. The **top-level files**, currently grouped logically below but kept flat
   (a future Phase 4 / ST1 PR will subdir them by concern; see
   `docs/architecture/post-audit-cleanup-plan.md`).

If you don't know where to start: **`commands/index.ts`** is the dispatcher
that maps each canonical lifecycle command (`/discover`, `/build`, etc.) to
its handler.

## Subdirectories

| Path | What lives here |
|---|---|
| `commands/` | One file per canonical lifecycle command (`build.ts`, `discover.ts`, `frame.ts`, `handoff.ts`, `plan.ts`, `qa.ts`, `review.ts`, `ship.ts`, `closeout.ts`) plus `index.ts` that dispatches. |
| `adapters/` | Provider adapters: `ccb.ts` (governed CCB path), `local.ts` (local provider single-shell path), plus `gsd.ts`, `pm.ts`, `superpowers.ts` for absorbed-pattern integrations. `registry.ts` picks the right adapter; `prompt-contracts.ts` defines shared prompt shapes; `types.ts` is the adapter contract. |
| `stage-packs/` | One stage pack per canonical stage (`build.ts`, `qa.ts`, etc.) — packaged prompts + context bundles handed to adapters. `source-map.ts` records absorbed-source provenance. |
| `stage-content/` | Per-stage markdown content (artifact-contract, exit-condition, etc.) loaded at runtime. Mirrors the canonical stage names. |
| `absorption/` | Records of patterns absorbed from upstream sources (`ccb/`, `gsd/`, `pm/`, `superpowers/`). Supports the maintainer loop's "what did we already pull in?" gate. |
| `normalizers/` | Per-source result normalizers — they translate raw external responses into Nexus's canonical record shapes. |

## Top-level files (grouped by concern)

The following grouping is **descriptive**, not enforced by directory
structure. Phase 4 / ST1 plans to subdir these.

### Foundations
- `types.ts` — every record type, status union, and configuration shape
- `artifacts.ts` — canonical paths under `.planning/current/<stage>/`
- `command-manifest.ts` — the canonical command list + per-stage IO contract
- `contract-artifacts.ts` — schema-versioned artifact emitters
- `transitions.ts` — allowed stage-to-stage transitions
- `governance.ts` — the run ledger invariant guard
- `status.ts` — read/write per-stage `status.json`

### Release flow
- `release-contract.ts` — release manifest schema and version arithmetic
- `release-publication.ts` — local release preflight
- `release-publish.ts` — managed-release publish flow
- `release-remote.ts` — remote release smoke check

### Review flow
- `review-advisories.ts` — read/write review advisory records
- `review-receipts.ts` — per-attempt review audit receipts
- `review-scope.ts` — review scope mode (full_acceptance vs bounded_fix_cycle)
- `verification-matrix.ts` — which checklists apply for the current run

### Ledger / state
- `ledger.ts` — read/write `.planning/nexus/current-run.json`
- `ledger-doctor.ts` — ledger repair/diagnostic
- `run-bootstrap.ts` — next-run bootstrap from closeout
- `retro-archive.ts` — archived retro continuity
- `learnings.ts` — runs-level learning candidates

### Runtime / execution
- `runtime-cwd.ts` — cwd resolution rules
- `runtime-invocation.ts` — adapter invocation envelope
- `execution-topology.ts` — `governed_ccb` vs `local_provider` mode
- `command-runner.ts` — subprocess runner used by adapters
- `ccb-runtime-state.ts` — CCB provider mount + dispatch state files

### Follow-on / closeout
- `follow-on-evidence.ts` — canary + deploy result evidence
- `closeout-follow-on-refresh.ts` — closeout's follow-on refresh path
- `session-continuation-advice.ts` — session continuation prompts

### Host / install
- `host-roots.ts` — per-host install path resolution
- `external-skills.ts` — runtime scan of user-installed skills (Claude / Codex / Gemini CLI / Factory)
- `install-metadata.ts` — `.nexus-install.json` install record
- `update-state.ts` — `~/.nexus/update-state/` files
- `repo-paths.ts` — canonical repo-relative path constants
- `repo-taxonomy.ts` — what's source-of-truth vs compat surface
- `compatibility-surface.ts` — runtime path resolver across taxonomy versions
- `upstream-compat.ts` — vendor compatibility alias resolver
- `upstream-maintenance.ts` — absorbed-source maintenance metadata

### Advisors / surfaces
- `completion-advisor.ts` — what to do next after each stage completes
- `cli-advisor.ts` — terminal renderer for the completion advisor
- `support-surface.ts` — discovery roots for support skills
- `product-surface.ts` — product context (DESIGN.md, ETHOS.md, BROWSER.md)

### Contracts (besides verification-matrix)
- `design-contract.ts` — design intent record + design-checklist applicability
- `deploy-contract.ts` — deploy configuration record
- `ship-pull-request.ts` — PR handoff record + safe `git push` command rendering

### Helpers
- `validation-helpers.ts` — shared `isRecord`, `assertString`, JSON-read helpers (strict + lenient)
- `shell-quote.ts` — POSIX shell-safe quoting
- `conflicts.ts` — repo conflict detection
- `migration-safety.ts` — checks before destructive maintainer migrations
- `maintainer-loop.ts` — maintainer-side automation loop
- `skill-structure.ts` — source taxonomy for `skills/` (canonical / support / safety / aliases / root)
- `workspace-substrate.ts` — run workspace allocation under `.nexus-worktrees/`

## Conventions

- **Lenient vs strict JSON reads** — `validation-helpers.ts` exports both. Use
  `readJsonFile<T>(path, validator)` (strict, validator throws) for "this
  artifact must be well-formed" sites. Use `readJsonPartial`,
  `readJsonPartialOr`, or `readJsonResult` for "missing/malformed → fall
  through" sites. The lenient family was added in PR #22.
- **Type-only imports** — prefer `import type { ... }` for shape-only
  references to keep runtime cycles minimal.
- **No `process.cwd()` defaults inside lib code** — push the default to CLI
  entry points (`bin/nexus.ts`) so testing can inject alternate roots.
  (Phase 3 follow-up; some current sites still take `cwd = process.cwd()`.)
- **Skill prose calls the runtime via `bun run bin/nexus.ts <command>`** —
  do not import lib modules from skill prose, do not assume any host-specific
  runtime location.

## Tests

Tests live under `test/nexus/` and roughly mirror the per-file layout. Phase 4
/ ST9 plans to mirror any future `lib/nexus/` subdirectory split into the
test tree.

The `~55 of 113` modules currently lacking direct tests are tracked under
finding §3.1 in `docs/architecture/post-audit-cleanup-plan.md`. Phase 3 is
adding coverage for the highest-risk ones first (closeout-follow-on-refresh,
ship-pull-request, review-advisories, deploy-contract, command-runner).

## Related

- `docs/architecture/repo-taxonomy-v2.md` — the post-taxonomy-v2 active root
  layout
- `docs/architecture/post-audit-cleanup-plan.md` — known gaps and the phased
  plan to close them
- `docs/architecture/superpowers-absorption.md` — what was absorbed from
  Superpowers and what was deliberately left
- `bin/nexus.ts` — the CLI entrypoint that drives this directory
