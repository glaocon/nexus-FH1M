# Scripts

Repository scripts are grouped by concern:

- `scripts/build/` - build orchestration and cleanup.
- `scripts/skill/` - skill discovery, generation, validation, doctor, and watch tooling.
- `scripts/repo/` - repository health and taxonomy inventory tooling.
- `scripts/eval/` - eval history, comparison, selection, summary, and live watch helpers.
- `scripts/resolvers/` - shared SKILL.md template resolvers used by `scripts/skill/gen-skill-docs.ts`.

Prefer package scripts in `package.json` for routine use. Direct `bun run`
invocations should point at the grouped paths above.
