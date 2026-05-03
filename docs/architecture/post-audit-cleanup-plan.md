# Post-Audit Cleanup Plan

Comprehensive plan for landing the post-audit cleanup work in Nexus. This
document is the handoff surface — anyone (human contributor or AI) picking up
the cleanup should read this end-to-end before starting.

- **Audit date**: 2026-04-30 (against `main` at `f575c7c`)
- **Scope**: code quality, test coverage, security, path/taxonomy follow-ups,
  project structure, documentation drift
- **Status**: Phase 1 + Phase 2.1 + Phase 2.2 in flight as PR #15 / #16 / #17;
  Phase 2.3 + Phase 3 + Phase 4 still open

## How to use this document

1. Read the **Findings** section to understand what's broken or duplicated.
2. Read the **Phase Roadmap** to see the recommended sequencing.
3. Read **Active PRs** to see what's already in flight (so you don't duplicate
   work).
4. Pick the next phase that fits your appetite. Each phase is sized to be a
   single focused PR.

If a finding is marked "addressed in PR #N", you can skip it — the work is
already done and waiting for review or merge. If a finding is marked "open",
nobody has started it yet.

---

## Findings

Six audit dimensions ran in parallel against `main`. Findings are reported
with file:line references so they can be picked up cold.

### 1. Security (P0)

| # | Severity | Site | Finding | Status |
|---|---|---|---|---|
| S1 | High | `lib/nexus/ship-pull-request.ts:64` | `git push -u ${remote} HEAD` interpolates a git remote name into a displayed shell command. Git ref names can technically contain shell metacharacters (`;`, `&`, `|`, `$`, `` ` ``). Copy-pasting a malicious value runs arbitrary code. | Addressed in **PR #15** |
| S2 | High | `lib/nexus/completion-advisor.ts:1162` | Same pattern — `git push -u origin ${pullRequest.head_branch}` fallback. | Addressed in **PR #15** |
| S3 | Medium | `runtimes/browse/src/sidebar-agent.ts:328,338` | `stderrBuffer.trim().slice(-500)` surfaced in user-facing error messages — subprocess stderr can leak tokens or API keys. | Open → **Phase 3** |
| S4 | Low | `runtimes/browse/src/sidebar-agent.ts:334` | `parseInt(process.env.SIDEBAR_AGENT_TIMEOUT || '300000', 10)` has no upper bound; bad env values cause logic errors. | Open → **Phase 3** |
| S5 | Low | `runtimes/browse/src/server.ts:39` | `AUTH_TOKEN = crypto.randomUUID()` regenerated per process; restart breaks existing clients. | Open → **Phase 3** (design choice — may be "won't fix") |
| S6 | Low | `lib/nexus/workspace-substrate.ts:131-132` | `RUN_WORKSPACE_SYNC_PATHS` allowlist exists but the `.join()` doesn't re-assert membership at call site. | Open → **Phase 3** |

No `eval` / `new Function` / unsafe deserialization. JSON parsing wrapped in
try/catch where it matters. Network surfaces (browse server, MCP) reviewed —
no obvious port-binding or CORS issues.

### 2. Code quality

#### 2.1 Duplicate validators (8 modules)

Six near-identical helpers (`isRecord`, `assertString`, `assertStringArray`,
`assertBoolean`, `assertNullableString`, plus an `isObject` variant) appeared
across 8 modules. Plus a `readJsonFile<T>(path, validator)` helper sitting in
one module that other read sites should reuse.

| Helper | Duplicate count | Modules |
|---|---|---|
| `isRecord` | 6 | release-contract, maintainer-loop, update-state, release-publish, install-metadata, release-remote |
| `isObject` (≈ `isRecord`) | 2 | review-advisories, verification-matrix |
| `assertString` | 6 | (same set as `isRecord`) |
| `assertStringArray` | 3 | maintainer-loop, release-publish, release-remote |
| `assertBoolean` | 1 | release-contract |
| `assertNullableString` | 1 | install-metadata |
| `readJsonFile<T>` | 1 (private) | update-state |

**Status**: Addressed in **PR #16** (Phase 2.1) — extracted to
`lib/nexus/validation-helpers.ts` and consolidated. PR #17 (Phase 2.2)
migrates 6 read sites to use the new `readJsonFile<T>`.

#### 2.2 Inconsistent JSON read patterns (28 sites)

Four variants coexist across `lib/nexus/`:

| Pattern | Count | Description |
|---|---|---|
| A — direct cast | ~10 | `JSON.parse(readFileSync(path, 'utf8')) as Type` |
| B — `as unknown` + manual validation | ~5 | Followed by `if (!isRecord(...))` etc. |
| C — `as Partial<T>` defensive merge | ~5 | `run-bootstrap.ts`, `ccb-runtime-state.ts`, `verification-matrix.ts` |
| D — broad try/catch wrapper | ~7 | `closeout-follow-on-refresh.ts`, `retro-archive.ts`, `deploy-contract.ts` |
| E — bare untyped | ~2 | `verification-matrix.ts:798,814` |

**Status**: PR #17 covers patterns A and B (6 sites). Patterns C and D need
deeper redesign — see Phase 2.3.

#### 2.3 `process.cwd()` defaults in 13+ lib functions

`governance.ts:155-170`, `ledger.ts:28-41`, `status.ts:9-18`,
`install-metadata.ts:224-239`, `release-contract.ts:28`, `release-publish.ts`,
`external-skills.ts:206`. Lib code shouldn't reach for ambient state — push
defaults to CLI entry points.

**Status**: Open. Phase 3 candidate.

#### 2.4 Throw-vs-null inconsistency

Same module families mix throw (`governance.ts` 26x, `adapters/local.ts` 14x)
with silent `return null` (`ledger.ts`, `status.ts`). Pick a Result-shape or
a documented convention.

**Status**: Open. Phase 3 candidate.

#### 2.5 Unsafe `as` casts on subprocess output

`JSON.parse(stdout) as GithubPullRequestPayload` in `ship-pull-request.ts`,
`ledger-doctor.ts`, `execution-topology.ts`. External payload shape isn't
enforced.

**Status**: Open. Phase 3 candidate.

#### 2.6 26x identical error message in governance

`governance.ts:8-90` — 26 `throw new Error('Run ledger is not canonical')`
statements. Use discriminating error types or codes so callers can debug
which check failed.

**Status**: Open. Phase 3 candidate.

### 3. Test coverage

#### 3.1 Modules without tests (~55 of 113)

Highest-risk untested modules:

| Module | Why high-risk |
|---|---|
| `lib/nexus/closeout-follow-on-refresh.ts` | 6 error paths, broad try/catch hides JSON parse failures |
| `lib/nexus/ship-pull-request.ts` | Silent JSON parse, untested PR-state transitions |
| `lib/nexus/review-advisories.ts` | Two unguarded `JSON.parse` on external advisory payloads |
| `lib/nexus/deploy-contract.ts` | 10+ normalize functions, no edge-case tests |
| `lib/nexus/conflicts.ts` | Zero tests; raw mkdir/writeFile I/O |
| `lib/nexus/command-runner.ts` | Zero tests; raw `Bun.spawnSync`, no env-merge or cwd validation tests |
| `lib/nexus/follow-on-evidence.ts` | Zero direct tests; tested only indirectly |
| `lib/nexus/design-contract.ts` | Imported by verification-matrix.test.ts but not directly tested |

**Status**: Open. Phase 3 — add tests for the 5–8 highest-risk modules first.

#### 3.2 Tests asserting real-tree filesystem state

These break for sparse / CI-shape checkouts and conflate "code works" with
"this maintainer's working tree is intact":

- `test/nexus/upstream-maintenance.test.ts:66,115,118`
- `test/nexus/inventory.test.ts:164,194`
- `test/nexus/upstream-release-gate.test.ts:70-84`
- `test/nexus/skill-structure.test.ts:83-89`
- `test/nexus/qa.test.ts:376,444,503`

**Status**: Open. The pattern fix is in PR #13's
`test/nexus/repo-taxonomy.test.ts` (temp-dir fixture); apply the same shape
to the rest.

### 4. Path / taxonomy follow-ups

#### 4.1 Legacy `review/` source paths still in active code

Files referencing the pre-`references/` paths outside the compat-mapping
table:

- `scripts/resolvers/review-army.ts:2,22-30` (specialists/testing.md,
  security.md, maintainability.md)
- `scripts/resolvers/design.ts:2`
- `skills/support/document-release/SKILL.md` (review/TODOS-format.md)

**Status**: Open → **Phase 2.4**. PR #13 partially addressed this in
`verification-matrix.ts` and tests; resolvers and skill prose still pending.

#### 4.2 Generated host mirrors

`.agents/`, `.factory/`, `.gemini/` are all in the taxonomy as `future_move`
entries but their mirrors are not consistently checked:

- `scripts/skill-check.ts:189-217` checks `.agents/skills/`
- `scripts/skill-check.ts:221-248` checks `.factory/skills/`
- **No `.gemini/skills/` check** — silent monitoring gap

**Status**: Open → **Phase 1.5** (small one-off fix). Add `.gemini/skills/`
check to `scripts/skill-check.ts`.

#### 4.4 Host coverage gap in `defaultExternalSkillRoots`

`lib/nexus/external-skills.ts:206-214` lists default scan roots for runtime
discovery of user-installed skills. The list covers Claude (project + home)
and Codex (project + home, plus the legacy `~/.codex/skills/` path) but is
**missing Gemini CLI and Factory**. Symmetric to §4.2: 4 hosts in the
taxonomy, only 2 (Claude and Codex) get scanned.

Result: when a user has installed Nexus skills under `~/.gemini/skills/` or
`~/.factory/skills/`, the completion advisor doesn't see them and can't
recommend them as cooperative options for the current stage.

**Status**: Open → **Phase 1.6**. Add `<cwd>/.gemini/skills/`,
`<cwd>/.factory/skills/`, `~/.gemini/skills/`, `~/.factory/skills/` to
`defaultExternalSkillRoots`.

#### 4.3 Cross-platform build undocumented

`package.json` `build:server` requires `bash`, `build:chmod` requires
`chmod`. PR #13's `scripts/build.ts` rewrite makes the failure mode clearer
on Windows, but there's no README/CONTRIBUTING note that Windows requires
WSL2.

**Status**: Open → **Phase 4** (decide stance, then either docs note or
build-script rewrite).

### 5. Project structure

| # | Severity | Issue | Suggested fix |
|---|---|---|---|
| ST1 | High | `lib/nexus/` has 53 files at one level (with 6 subdirs that cover only some concerns). `release-*` (4 files), `review-*` (4), `ledger-*` (2), `runtime-*` (2), `follow-on-*` (2), `host-*` (3) all stay flat. | Subdir by concern: `release/`, `review/`, `ledger/`, `paths/`, `host/`, `follow-on/`. |
| ST2 | Medium | `lib/` only contains `lib/nexus/`. Unused indirection layer. | Either populate `lib/` (e.g., `lib/shared/`) or drop the layer. |
| ST3 | Medium | Root has ~24 files including 7 large markdown docs (~5,000 lines). `SKILL.md` (580 lines), `CHANGELOG.md` (1799), `TODOS.md` (715), `BROWSER.md` (399) at root. | **NOT a doc-only move**: `TODOS.md` is the unified backlog read/written by `/ship`, `/qa`, planning/review/retro skills (CONTRIBUTING:316, `scripts/resolvers/preamble.ts:580-581`, `scripts/resolvers/utility.ts:196`). `CHANGELOG.md` is read by `document-release` (`scripts/resolvers/utility.ts:449`). Both are runtime artifacts referenced by relative path in skill prose. Moving requires updating ~12 SKILL.md.tmpl + 12 generated SKILL.md + 3 resolver files + `lib/nexus/repo-taxonomy.ts:597,604` ROOT_FILES + regen + agent-behavior tests. **Code-shaped, not doc-shaped** — must wait for Phase 3 high-risk module test coverage. |
| ST4 | Medium | `bin/` mixes TypeScript source (`nexus.ts`, `nexus-global-discover.ts`) and built binaries. | Move `.ts` sources to `lib/nexus/cli/` and build into `bin/`. |
| ST5 | Medium | `runtimes/safety/` (hook helpers) collides naming with `skills/safety/` (skill defs). | Rename `runtimes/safety/` → `runtimes/hooks/`. |
| ST6 | Low | `hosts/claude/` vs `hosts/gemini-cli/` inconsistent suffix. | Standardize on suffix or no-suffix across hosts. |
| ST7 | Low | `agents/` at root is a directory of one (`openai.yaml`). | Drop the directory or document why. |
| ST8 | Low | `skills/root/` has exactly one subdir. | Fold into `canonical/` with a flag, or rename to make the asymmetry intentional. |
| ST9 | Low | `test/nexus/` is also flat (117 tests). | Mirror the eventual `lib/nexus/` subdirs. |
| ST10 | Low | `scripts/` has `eval-*` (5), `skill-*` (3), `upstream-*` (2) prefix clusters. | Optional grouping under `scripts/eval/`, `scripts/skill/`, `scripts/upstream/`. |

**Status**: All open. Phase 4 candidate (after Phases 1–3 stabilize).

### 6. Documentation drift

| # | Site | Issue |
|---|---|---|
| D1 | `hosts/gemini-cli/README.md:3-4` | Claims `.gemini/` is "Active source" — actually generated/compat under the new taxonomy. |
| D2 | `hosts/factory/README.md:3-4` | Same backwards claim for `.factory/`. |
| D3 | `CONTRIBUTING.md:70-84` | Directory tree shows `review/`, `ship/`, `browse/` at repo root — actually under `skills/canonical/` and `runtimes/`. |
| D4 | `README.md:50-51,63-65` | Describes `.factory/skills/` and `$NEXUS_ROOT/review/checklist.md` without flagging the `references/` migration. |
| D5 | `README.md:326-335` | Codex install path `.agents/skills/nexus` nesting inconsistent with line 50's description. |
| D6 | `references/review/README.md` | Missing or minimal — newly-active directory has no orientation doc. |
| D7 | `lib/nexus/` | Path-taxonomy engine has no orientation README. |
| D8 | `docs/superpowers/` | Cryptic name — sub-subdirs are `closeouts/`, `plans/`, `runbooks/`, `specs/`. Internal jargon. |

**Status**: All open. Phase 4 candidate.

---

## Phase Roadmap

The strategic frame: **pay down risk → consolidate → restructure → polish**.
Doing structure first without CI/test coverage is dangerous; doing tests first
without consolidation entrenches duplication.

### Phase 1 — Risk reduction

Small, targeted patches that unblock everything else.

- ✅ Fix two `git push` shell-injection sites (S1, S2)
- ✅ Fix build script false-pass (rewrite as `scripts/build.ts` with proper exit
  propagation + try/finally cleanup) — *done in PR #13*
- ✅ Gate fork-PR CI workflow so build-image doesn't fail with permission errors

**Done in**: PR #15 (this session) + PR #13 (parallel work).

### Phase 1.5 — Small monitoring patches

One-off fixes that fit naturally with Phase 1's "stop the bleeding" theme but
weren't on the original Phase 1 scope.

- 🔲 Add `.gemini/skills/` existence check to `scripts/skill-check.ts`
  (parallel to the existing `.agents/` and `.factory/` checks). Closes
  finding §4.2. ~5 lines.

### Phase 1.6 — External-skill scan host coverage

Same shape as Phase 1.5 — closing a 4-host symmetry gap.

- 🔲 Add `.gemini/skills/` and `.factory/skills/` (project + home scope) to
  `defaultExternalSkillRoots` in `lib/nexus/external-skills.ts`. Closes
  finding §4.4. ~5 lines plus a coverage test.

### Phase 2 — Consolidate duplicates

Mechanical refactor. Low risk, compounding readability win.

- ✅ Phase 2.1: extract `lib/nexus/validation-helpers.ts`, migrate 8 modules
  (PR #16)
- ✅ Phase 2.2: migrate Pattern A + B JSON read sites to `readJsonFile<T>`
  (PR #17, 6 sites)
- 🔲 Phase 2.3: redesign Pattern C/D sites for typed errors and structured
  fallbacks. Touches:
  - `closeout-follow-on-refresh.ts`
  - `retro-archive.ts`
  - `deploy-contract.ts`
  - `run-bootstrap.ts:227,243`
  - `ccb-runtime-state.ts:153,190`
  - `follow-on-evidence.ts:17`
  Estimated ~7 files, requires designing a shared error/fallback shape first
  (likely a `Result<T, E>`-style helper or a typed `safeParseJsonFile`).
  Closes finding §2.2 (Patterns C/D and E).

- 🔲 Phase 2.4: finish the legacy `review/` → `references/review/` migration in
  active code. Targets:
  - `scripts/resolvers/review-army.ts:2,22-30`
  - `scripts/resolvers/design.ts:2`
  - `skills/support/document-release/SKILL.md`
  Closes finding §4.1.

### Phase 3 — Tests + invariants

Once the helpers are consolidated, add tests + invariants for the highest-risk
untested modules.

Priority order (by risk × user-visibility):

1. `lib/nexus/closeout-follow-on-refresh.ts` — ~6 error paths, untested
2. `lib/nexus/ship-pull-request.ts` — silent JSON parse, PR-state transitions
3. `lib/nexus/review-advisories.ts` — external advisory payload parsing
4. `lib/nexus/deploy-contract.ts` — normalize functions
5. `lib/nexus/command-runner.ts` — raw subprocess spawning
6. Replace 5 filesystem-bound integration tests with temp-dir fixtures
   (`upstream-maintenance.test.ts`, `inventory.test.ts`,
   `upstream-release-gate.test.ts`, `skill-structure.test.ts`, `qa.test.ts`)

Smaller follow-ups in this phase (good first issues for contributors):

- Push `process.cwd()` defaults to CLI entry points (§2.3)
- Pick one return convention (throw vs null) per module family (§2.4)
- Replace `as Type` casts on subprocess output with type-guard validators (§2.5)
- Discriminating error codes in `governance.ts` (§2.6)
- Redact subprocess stderr before surfacing in error messages (§S3)
- Bound the SIDEBAR_AGENT_TIMEOUT env-var parse (§S4)
- Either persist or document the AUTH_TOKEN regenerate-per-process behavior (§S5)
- Re-assert `RUN_WORKSPACE_SYNC_PATHS` membership at the workspace `.join()`
  call site (§S6)

### Phase 4 — Structure + documentation

Has two cohorts: **doc-shaped** (safe now) and **code-shaped** (wait for
Phase 3 high-risk module tests). Restructuring imports / runtime paths
without test coverage is fragile, so the code-shaped cohort blocks until
the Phase 3 priority list is in.

#### Doc-shaped (safe to do in parallel with Phase 3)

These touch only documentation; no runtime path changes, no skill prose
updates, no taxonomy churn.

- **D1, D2** — rewrite `hosts/gemini-cli/README.md` and `hosts/factory/README.md`
  to reflect the post-PR-#13 reality (tracked-source vs. generated-output split)
- **§4.3 / Step #9** — add a "Windows requires WSL2" note to README/CONTRIBUTING
- **D3, D4, D5** — fix root `README.md` drift (path descriptions, Codex install
  path inconsistency, `.factory/skills/` description)
- **D6, D7** — write `references/review/README.md` and `lib/nexus/README.md`
- **D8 / Step #10 partial** — optional rename `docs/superpowers/` to a clearer
  name (pure documentation tree reorganization)

#### Code-shaped (blocked on Phase 3 test coverage)

These change runtime paths or contracts. Do not start until the Phase 3
high-risk module tests (closeout-follow-on-refresh, ship-pull-request,
review-advisories, deploy-contract, command-runner) are in main.

1. Subdir `lib/nexus/` by concern (ST1) — 50+ import paths change
2. Mirror in `test/nexus/` (ST9) — moves alongside ST1
3. **Move `CHANGELOG.md` / `TODOS.md` out of repo root (ST3) — NOT a doc-only
   move**. Both are runtime artifacts referenced by skill prose and resolvers
   (see Findings §5 ST3 row for the full reference list). Moving requires
   updating ~12 SKILL.md.tmpl + generated SKILL.md outputs + 3 resolver files
   + `lib/nexus/repo-taxonomy.ts` ROOT_FILES + regenerating + verifying agent
   behavior at the new paths.
4. Decide on `agents/openai.yaml` (ST7), `skills/root/` (ST8), and the
   single-child `lib/` directory (ST2). All three are "directory of one"
   shape — pick one resolution per directory (drop, fold, or document).
5. Split `bin/` source from built artifacts (ST4) — move the `.ts` entry
   files into `lib/nexus/cli/` or `runtimes/cli/` and have `bin/` contain
   only built/shipped binaries.
6. Rename `runtimes/safety/` → `runtimes/hooks/` (ST5) — coordinated migration
   like PR #13 attempted, due to install-path implications.
7. Standardize `hosts/*` naming (ST6).
8. Optional: group `scripts/` (ST10).

---

## Active PRs

Snapshot at the time this document was written. Check the PR list directly for
the current state.

| PR | Branch | Scope | Status |
|---|---|---|---|
| #13 | `glaocon:codex-updates` | Path canonicalization, build script rewrite, compat alias resolver | Open, 0 CI runs (fork-PR push limitation; will recover after #15 merges) |
| #14 | `glaocon:codex/superpowers-evidence-gates` | Absorb Superpowers evidence gates | Open, 0 CI runs; has a generator-strip bug in 8 SKILL.md files (commented as nudge) |
| #15 | `claude/review-pr-13-zUTar` | Phase 1 — shell-quote git push + fork PR CI gate | Open, 18/18 CI ✅ |
| #16 | `claude/phase-2-validation-helpers` | Phase 2.1 — extract validation-helpers, 8 modules | Open, CI in progress |
| #17 | `claude/phase-2-2-readjsonfile-migration` | Phase 2.2 — migrate 6 read sites to readJsonFile | Open, stacked on #16 |

After #15 merges, #13 / #14 should be re-run through CI to verify them.

---

## Handoff guide

If you're picking this up cold:

### Read first
1. This file (you're here).
2. `lib/nexus/repo-taxonomy.ts` to understand the directory model.
3. `CLAUDE.md` for the Nexus skill routing model.

### To continue Phase 2.3
Start with a design for the shared error / fallback shape (`Result<T, E>`-style
or extended `readJsonFile`). The 7 sites under "Pattern C/D" in Section 2.2 are
the targets. Open one PR per cohesive group (e.g., one PR for the
`Partial<T>` defensive-merge sites, one for the broad try/catch sites).

### To continue Phase 3
Pick the highest-priority untested module from Section 3.1 and write a test
file matching the existing `test/nexus/<module>.test.ts` convention. Use
`mkdtempSync` fixtures rather than asserting on real-tree state.

### To continue Phase 4
**Do not start before Phases 2 and 3 are done.** Restructuring without test
coverage is fragile. When you do start, use the order in the Phase 4 section
above.

### Branching convention used so far
- `claude/phase-N-<short-description>` for Claude-driven work
- One PR per phase; PRs stack when later phases depend on earlier ones
- Doc-only PRs base on `main` directly

### Verification baseline
The 47–48 failing tests under `bun test test/nexus/` in sandboxed environments
are pre-existing `git`/worktree issues (`fatal: invalid reference: main`,
`git commit` exit 128, etc.) unrelated to any cleanup work. Compare the
failing-test set with `comm -23 <new> <baseline>` after stripping `[123ms]`
timings to confirm no regressions.

---

## Finding → Phase coverage

Every finding in this document maps to exactly one phase. Use this table to
sanity-check that nothing is orphaned.

| Finding | Phase |
|---|---|
| S1, S2 (git push injection) | Phase 1 ✅ |
| S3 (stderr leakage) | Phase 3 |
| S4 (timeout bound) | Phase 3 |
| S5 (auth token regen) | Phase 3 (may be "won't fix") |
| S6 (workspace allowlist) | Phase 3 |
| §2.1 (duplicate validators) | Phase 2.1 ✅ |
| §2.2 Patterns A/B (JSON read) | Phase 2.2 ✅ |
| §2.2 Patterns C/D/E | Phase 2.3 |
| §2.3 (process.cwd defaults) | Phase 3 follow-up |
| §2.4 (throw vs null) | Phase 3 follow-up |
| §2.5 (subprocess casts) | Phase 3 follow-up |
| §2.6 (governance error codes) | Phase 3 follow-up |
| §3.1 (untested modules) | Phase 3 priority list |
| §3.2 (filesystem-bound tests) | Phase 3 step 6 |
| §4.1 (legacy `review/` paths) | Phase 2.4 |
| §4.2 (`.gemini/skills/` check) | Phase 1.5 |
| §4.4 (host coverage gap in `defaultExternalSkillRoots`) | Phase 1.6 |
| §4.3 (cross-platform build) | Phase 4 step 9 |
| ST1, ST2, ST3, ST4, ST5, ST6, ST7, ST8, ST9, ST10 | Phase 4 (steps 1–10) |
| D1, D2, D3, D4, D5, D6, D7 | Phase 4 step 8 |
| D8 | Phase 4 step 10 (optional) |

---

## Future work (out of cleanup scope)

These are deliberate non-cleanup items — they are net-new product capabilities,
not debt repayment. They are tracked here so a future contributor can pick them
up without rediscovering the context, but they should be re-scoped through
`/discover` before any work begins.

### Deep external-skill cooperation

Today `lib/nexus/external-skills.ts` discovers user-installed skills across
hosts and `completion-advisor` surfaces them as `recommended_external_skills`
suggestions. That is a one-way "here are skills you might want to invoke"
relationship.

A deeper cooperation model could include:

- **Pipeline composition** — Nexus stage commands (e.g., `/build`) fan out to
  user-installed support skills automatically, with results written back to
  `.planning/current/<stage>/` so subsequent stages see them.
- **Adapter routing** — Nexus detects a user-installed `/codex-eng-review` (or
  similar) and routes the canonical `/review` stage through it as the audit
  provider, instead of (or alongside) the built-in CCB path.
- **Shared state** — external skills can read Nexus run-ledger / stage-status
  artifacts and write their own evidence under a stable contract, not via
  recommendation only.

This is a product-level decision (touches the contract surface, lifecycle, and
host ergonomics), not a refactor. Open `/discover` first to clarify target
users, value vs. cost, and the contract shape before any code work.
