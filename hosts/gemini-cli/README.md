# Gemini CLI Host Facade

This directory is the **tracked host source** root for the Gemini CLI host
under the post-taxonomy-v2 layout. Currently it holds only this facade README;
host-specific tracked assets (e.g., a future `gemini-cli/agent.yaml` or
provider-side configuration) will land here as they are added.

## Where things live

| What | Where | Tracked? |
|---|---|---|
| Skill templates (shared across hosts) | `skills/canonical/`, `skills/safety/`, `skills/support/` | ✅ tracked |
| This host facade | `hosts/gemini-cli/` (you are here) | ✅ tracked |
| Generated Gemini-formatted output | `.gemini/skills/<skill-name>/SKILL.md` | ❌ gitignored |

## How output reaches Gemini CLI users

1. Maintainer runs `bun run gen:skill-docs --host gemini-cli`.
2. `scripts/gen-skill-docs.ts` reads each `.tmpl` source, applies
   Gemini-specific frontmatter rules (name + description only, 1024-char
   description limit), and writes to `.gemini/skills/<name>/SKILL.md`.
3. On install, `setup` copies the generated `.gemini/skills/` tree into the
   user's Gemini CLI install root.

## Why `.gemini/` is gitignored

`.gemini/skills/` is generator output, not source. Committing it would create
two divergent sources of truth (template vs. generated file) and let drift
slip in. The generator is the single source; the freshness gate in
`scripts/skill-check.ts` enforces this on every change.

## Related

- `hosts/codex/README.md` — sibling host facade for Codex.
- `hosts/claude/README.md` — sibling host facade for Claude.
- `hosts/factory/README.md` — sibling host facade for Factory.
- `lib/nexus/repo-taxonomy.ts` — canonical record of which paths are
  source-of-truth vs. compatibility surfaces.
