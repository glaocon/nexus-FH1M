# Nexus Repo Taxonomy v2

The root `/nexus` source template has moved into the skill taxonomy. The Chrome
extension source, design runtime, runtime sidecars, and tracked host source
sidecars have moved under their taxonomy roots. Remaining generated host output stays in
compatibility locations until a migration explicitly updates setup, generated
host surfaces, runtime path rewrites, and tests.

Phase 3 adds documentation-only facades under `runtimes/`, `references/`, and
`hosts/`. These facades improve repo navigation, but they are not executable
runtime roots, not installable reference sources, and not generated host output.

## Target Tree

```text
nexus/
  skills/
    root/nexus/
    canonical/
    support/
    safety/
    aliases/

  runtimes/
    browse/
      extension/
    design/
    design-html/
    hooks/

  references/
    review/
    qa/
    design/
    cso/

  lib/
    nexus/
      commands/
      completion-advisor/
      intent-classifier/
      skill-registry/
      stage-content/
      stage-packs/

  hosts/
    claude/
      rules/
    codex/
      openai.yaml
    gemini-cli/
    factory/
    kiro/

  bin/
  scripts/
  docs/
  test/
```

## Current Policy

Most current paths remain the active source of truth until a migration
explicitly updates setup, generated host surfaces, runtime path rewrites, and
tests. The root `/nexus` source template now lives under
`skills/root/nexus/`; root `SKILL.md` remains a generated compatibility mirror.
The Chrome extension source now lives under `runtimes/browse/extension/`, the
design runtime now lives under `runtimes/design/`, runtime sidecars now live
under `runtimes/design-html/` and `runtimes/hooks/`, tracked host sidecars now
live under `hosts/`, while installed host compatibility paths remain stable.

Inside `lib/nexus/`, `skill-registry/` is the active home for installed skill
discovery, manifest loading, classification, and ranking. `intent-classifier/`
is the active home for `/nexus do` routing. Generated host output may carry
`nexus.skill.yaml` manifests, but the registry and dispatcher own the runtime
interpretation of those manifests.

`stage-content/` and `stage-packs/` are native Nexus sources after D2. Stage
packs are no longer modeled as imported external content; `stage-packs/` owns
the lifecycle pack factories, `stage-packs/native-builders.ts` owns native
builder helpers, and `stage-content/` owns source bindings for canonical stage
guidance.

Representative current-to-target mappings:

- `skills/root/nexus/SKILL.md.tmpl` -> `skills/root/nexus/SKILL.md.tmpl`
- `SKILL.md` -> `skills/root/nexus/SKILL.md` (generated compatibility mirror)
- `browse` -> `runtimes/browse`
- `runtimes/browse/extension` -> `runtimes/browse/extension`
- `runtimes/design` -> `runtimes/design`
- `runtimes/design-html` -> `runtimes/design-html`
- `runtimes/hooks/careful` -> `runtimes/hooks/careful`
- `runtimes/hooks/freeze` -> `runtimes/hooks/freeze`
- `lib/nexus/skill-registry/` -> `lib/nexus/skill-registry/`
- `lib/nexus/stage-content/` -> `lib/nexus/stage-content/`
- `lib/nexus/stage-packs/native-builders.ts` -> `lib/nexus/stage-packs/native-builders.ts`
- `design/references` -> `references/design`
- `review` -> `references/review`
- `qa` -> `references/qa`
- `.claude/rules` -> `hosts/claude/rules`
- `.agents` -> `hosts/codex`
- `agents/openai.yaml` -> `hosts/codex/openai.yaml`
- `.factory` -> `hosts/factory`

Compatibility matters more than visual cleanup. Any future move must preserve
installed runtime paths such as:

- `$NEXUS_ROOT/browse/dist`
- `$NEXUS_ROOT/browse/bin`
- `$NEXUS_ROOT/extension/manifest.json`
- `$NEXUS_ROOT/design/dist`
- `$NEXUS_ROOT/design/references`
- `$NEXUS_ROOT/design-html/vendor`
- `$NEXUS_ROOT/careful/bin`
- `$NEXUS_ROOT/freeze/bin`
- `$NEXUS_ROOT/review/checklist.md`
- `$NEXUS_ROOT/review/specialists/testing.md`
- `$NEXUS_ROOT/qa/templates/qa-report-template.md`
- `.claude/rules/*`
- `agents/openai.yaml`

## Phase 4 First Reference Move

The first physical reference batch has moved low-risk sidecars into
`references/` while preserving installed runtime paths through setup compatibility
links:

- `review/checklist.md` -> `references/review/checklist.md`
- `review/design-checklist.md` -> `references/review/design-checklist.md`
- `review/greptile-triage.md` -> `references/review/greptile-triage.md`
- `review/TODOS-format.md` -> `references/review/TODOS-format.md`
- `qa/templates/` -> `references/qa/templates/`
- `qa/references/` -> `references/qa/references/`
- `cso/ACKNOWLEDGEMENTS.md` -> `references/cso/ACKNOWLEDGEMENTS.md`

Generated skills may still reference historical install paths like
`$NEXUS_ROOT/review/checklist.md`; setup maps those paths to the moved source
paths.

## Phase 5 Design Reference Move

The design methodology sidecars have moved under the real reference taxonomy
root:

- `design/references/` -> `references/design/`

Generated design skills may still reference `$NEXUS_ROOT/design/references/...`;
setup maps that installed compatibility path to the moved `references/design/`
source directory.

## Phase 6 Review Specialist Move

The review specialist prompts have moved under the review reference taxonomy
root:

- `review/specialists/` -> `references/review/specialists/`

Generated review skills may still reference
`$NEXUS_ROOT/review/specialists/...`; setup maps that installed compatibility
path to the moved `references/review/specialists/` source directory.

## Phase 7 Browse Extension Runtime Move

The Chrome side panel extension source has moved under the browse runtime
taxonomy:

- `extension/` -> `runtimes/browse/extension/`

Generated and installed skills still use `$NEXUS_ROOT/extension/...` for Chrome
auto-load and manual install flows. Setup maps that installed compatibility
path to `runtimes/browse/extension/`, while runtime resolvers still accept the
legacy source path for older installed branches.

## Phase 8 Design Runtime Move

The design runtime source, scripts, assets, tests, and compiled binary output
have moved under the runtime taxonomy:

- `design/` -> `runtimes/design/`

Generated skills still use `$NEXUS_ROOT/design/dist` for the design binary and
`$NEXUS_ROOT/design/references` for design methodology sidecars. Setup maps
those installed compatibility paths to `runtimes/design/dist` and
`references/design`.

## Phase 9 Runtime Sidecar Move

Runtime sidecars have moved under the runtime taxonomy:

- `design-html/` -> `runtimes/design-html/`
- `careful/` -> `runtimes/hooks/careful/`
- `freeze/` -> `runtimes/hooks/freeze/`

Generated and installed skills still use historical compatibility paths for
runtime sidecars. Setup maps `$NEXUS_ROOT/design-html/vendor` to
`runtimes/design-html/vendor`, `$NEXUS_ROOT/careful/bin` to
`runtimes/hooks/careful/bin`, and `$NEXUS_ROOT/freeze/bin` to
`runtimes/hooks/freeze/bin`.

## Phase 10 Host Source Move

Tracked host source sidecars have moved under the host taxonomy:

- `.claude/rules/` -> `hosts/claude/rules/`
- `agents/openai.yaml` -> `hosts/codex/openai.yaml`

Compatibility paths remain present as symlinks because the hosts still discover
those locations directly. Generated host output remains in `.agents/`,
`.gemini/`, and `.factory/`; those directories are install-time output, not
tracked source-of-truth.

## Remaining Conservative Facades

The remaining facade slice is intentionally conservative:

- `runtimes/*.md` points to active runtime roots. `runtimes/browse/`,
  `runtimes/design/`, `runtimes/design-html/`, and `runtimes/hooks/` are
  migrated source paths while installed compatibility paths remain stable.
- `references/review/README.md`, `references/qa/README.md`,
  `references/design/README.md`, and `references/cso/README.md` document active
  reference roots and the runtime compatibility paths that still point at
  historical install locations.
- `hosts/*/README.md` records intended host categories. Tracked Claude rules and
  Codex root metadata now live under `hosts/`; `.claude/rules/` and
  `agents/openai.yaml` remain compatibility symlinks.
- `.agents/`, `.gemini/`, and `.factory/` remain generated host output roots and
  should not be treated as tracked source-of-truth.

Guarded future paths must stay absent until their migration batch moves assets
and updates compatibility logic. Remaining examples are host-focused, such as
generated host output roots.

## First-Class Host Targets

`hosts/` is a host taxonomy, not just a mirror of current generated output.
The intended host set is:

- `hosts/claude`
- `hosts/codex`
- `hosts/gemini-cli`
- `hosts/factory`
- `hosts/kiro`

Gemini CLI is included even though current repo output is not yet generated
under a dedicated Gemini host tree. It should not be added later as an ad hoc
exception.

## Move Policies

- `keep_in_place`: current path already matches the target taxonomy or is a
  stable top-level utility root.
- `compat_required`: path can move only after setup creates compatibility
  links/copies for the existing `$NEXUS_ROOT/...` runtime paths.
- `future_move`: intended target is recorded, but moving now would require
  coordinated generator, setup, docs, and test changes.

## Intentional repo-root files

Two files are deliberately kept at repo root despite the general "minimize root
churn" instinct. Decision recorded in `track-c-st3-rfc.md` (2026-05-05,
Option A):

- **`CHANGELOG.md`** — release artifact. OSS convention strongly favors root
  placement (GitHub Releases auto-link, many tools assume the path). Read at
  runtime by `scripts/resolvers/utility.ts`.
- **`TODOS.md`** — planning artifact. Read at runtime by
  `scripts/resolvers/{preamble,review,utility}.ts` during `/review` and `/qa`
  flows. Co-located with `CHANGELOG.md` for symmetry; their root placement is
  intentional even though `TODOS.md` is more planning-shaped than
  documentation-shaped.

Both files are classified `keep_in_place` in the runtime taxonomy
(`lib/nexus/repo-taxonomy.ts`). If a future phase reconsiders, append a new
dated entry to `track-c-st3-rfc.md` § Decision log.

The executable taxonomy contract lives in `lib/nexus/repo-taxonomy.ts`, with
coverage in `test/nexus/repo-taxonomy.test.ts`.

The exhaustive tracked-file inventory is generated by
`scripts/repo/path-inventory.ts` and committed at
`docs/architecture/repo-path-inventory.md`. Regenerate it after taxonomy rule
changes with:

```bash
bun run repo:inventory
```
