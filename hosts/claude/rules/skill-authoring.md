---
paths:
  - "SKILL.md.tmpl"
  - "**/SKILL.md.tmpl"
  - "scripts/skill/gen-skill-docs.ts"
  - "scripts/resolvers/**/*.ts"
  - ".agents/skills/**/*.md"
  - "scripts/skill/check.ts"
  - "setup"
---

# Skill Authoring Rules

- `SKILL.md` files are generated outputs. Edit templates or generators first, then run `bun run gen:skill-docs --host codex` and commit the regenerated files.
- Keep host surfaces accurate: Claude-facing output must not hardcode `.agents/skills/`; Codex and Factory output must not hardcode `.claude/skills/`.
- Prefer repo-config-driven and host-agnostic instructions over framework-specific assumptions.
- In skill-template bash blocks, do not rely on shell state carrying across separate code fences.
- Preserve alias safety and canonical Nexus command ownership when touching setup, routing prompts, or wrapper generation.
- If repo-local `.claude/skills/nexus` or `.agents/skills/nexus` symlinks point at the repo root, remember that skill changes go live immediately in local sessions.
