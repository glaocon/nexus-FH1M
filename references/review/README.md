# `references/review/` — Review Checklist Sidecars

Lazy-loaded review-stage checklists, formats, and specialist prompts. These
files are read by `/review`, `/qa`, `/document-release`, and the verification
matrix at runtime; they are **not** code. The path is governed by the
post-taxonomy-v2 layout (PR #11–#13).

## What's here

### Top-level checklists and formats

| File | Read by | What it does |
|---|---|---|
| `checklist.md` | `/review` | The unified review checklist used during the dual-audit review stage. |
| `design-checklist.md` | `/review`, `/qa` (design verification), verification matrix (`accessibility` + `design` categories) | Design and accessibility checklist. The **canonical source path** for `verification-matrix.ts:checklists.{accessibility,design}.source_path`. |
| `greptile-triage.md` | `/review` | Triage rubric for incoming Greptile/automated review comments — keep / fix / out-of-scope buckets. |
| `TODOS-format.md` | `/document-release`, `/ship`, planning/review/retro skills | Canonical format for entries in the project-level `TODOS.md`. Skills append to `TODOS.md` using this template. |

### Specialists (`specialists/`)

Specialist prompts are loaded on demand by `/review`'s review-army resolver
based on the verification matrix's `support_skill_signals`. Each file
defines one specialist's review focus.

| File | Review angle |
|---|---|
| `testing.md` | Test coverage, fixture quality, regression-guard structure. Always-on. |
| `security.md` | Auth, secrets, permissions, input validation. Triggers on auth/backend surfaces. |
| `maintainability.md` | Complexity, dead code, duplication, simplification opportunities. Always-on. |
| `performance.md` | Latency, bundle size, query patterns. Triggers on frontend/backend surfaces. |
| `accessibility.md` | (Folded into `design-checklist.md`.) |
| `data-migration.md` | Schema/data migration safety. Triggers on `SCOPE_MIGRATIONS=true`. |
| `api-contract.md` | Public API contract stability. Triggers on `SCOPE_API=true`. |
| `red-team.md` | Adversarial review pass after the structured specialists. |

## How files reach installed Nexus users

These files are tracked under `references/review/` (the canonical source).
Setup creates compatibility links so installed users still see them at the
runtime paths their skills expect:

```
references/review/checklist.md          → $NEXUS_ROOT/review/checklist.md
references/review/design-checklist.md   → $NEXUS_ROOT/review/design-checklist.md
references/review/greptile-triage.md    → $NEXUS_ROOT/review/greptile-triage.md
references/review/TODOS-format.md       → $NEXUS_ROOT/review/TODOS-format.md
references/review/specialists/<*>.md    → $NEXUS_ROOT/review/specialists/<*>.md
```

The compatibility mapping is recorded in `lib/nexus/repo-taxonomy.ts:
REFERENCE_COMPAT_MAPPINGS`. Setup's `resolveReferenceCompatSource` falls
through to the legacy path if the migrated path is missing on a stale
install.

## Adding a new specialist

1. Drop the prompt at `references/review/specialists/<name>.md`.
2. Wire it into `verification-matrix.ts:CHECKLIST_DEFINITIONS` if it should
   appear under a checklist category, OR add it to the review-army resolver
   in `scripts/resolvers/review-army.ts` if it's scope-triggered.
3. If the file should also be installed, list it under the relevant
   `runtime_compat_paths` in `lib/nexus/repo-taxonomy.ts`.
4. Run `bun run skill:check` to confirm the freshness gate stays green.

## Related

- `lib/nexus/verification-matrix.ts` — which categories apply, where each
  category's `source_path` lives.
- `lib/nexus/review-advisories.ts` — what comes out of a review (advisory
  records) and how they get classified.
- `lib/nexus/repo-taxonomy.ts:REFERENCE_COMPAT_MAPPINGS` — the
  source/runtime compatibility table.
- `scripts/resolvers/review-army.ts` — the prose resolver that loads the
  right specialists for the current scope.
