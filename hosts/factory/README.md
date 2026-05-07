# Factory Host Facade

This directory is the **tracked host source** root for the Factory host
under the post-taxonomy-v2 layout. Currently it holds only this facade README;
host-specific tracked assets (e.g., a future `factory/manifest.yaml` or
provider-side configuration) will land here as they are added.

## Where things live

| What | Where | Tracked? |
|---|---|---|
| Skill templates (shared across hosts) | `skills/canonical/`, `skills/safety/`, `skills/support/` | ✅ tracked |
| This host facade | `hosts/factory/` (you are here) | ✅ tracked |
| Generated Factory-formatted output | `.factory/skills/<skill-name>/SKILL.md` | ❌ gitignored |

## How output reaches Factory users

1. Maintainer runs `bun run gen:skill-docs --host factory`.
2. `scripts/skill/gen-skill-docs.ts` reads each `.tmpl` source, applies
   Factory-specific frontmatter rules (name + description + `user-invocable`,
   plus `disable-model-invocation` when the source carries `sensitive: true`),
   translates Claude-Code tool names to host-agnostic phrasing, and writes to
   `.factory/skills/<name>/SKILL.md`.
3. On install, `setup` copies the generated `.factory/skills/` tree into the
   user's Factory install root.

## Why `.factory/` is gitignored

`.factory/skills/` is generator output, not source. Committing it would
create two divergent sources of truth (template vs. generated file) and let
drift slip in. The generator is the single source; the freshness gate in
`scripts/skill/check.ts` enforces this on every change.

## Sensitive-flag handling

Templates may carry `sensitive: true` to mark skills with destructive bash
hooks (e.g., `/ship`, `/careful`, `/freeze`). The Factory output preserves
this and adds `disable-model-invocation: true` so Factory only runs these
skills on explicit user request, never on model-driven inference.

## Related

- `hosts/claude/README.md` — sibling host facade for Claude.
- `hosts/codex/README.md` — sibling host facade for Codex.
- `hosts/gemini-cli/README.md` — sibling host facade for Gemini CLI.
- `lib/nexus/repo-taxonomy.ts` — canonical record of which paths are
  source-of-truth vs. compatibility surfaces.
- `scripts/skill/gen-skill-docs.ts:194-200` — the Factory frontmatter transform.
