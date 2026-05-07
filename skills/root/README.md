# Root Skill Taxonomy

`skills/root/` is intentionally a single-child taxonomy bucket.

Active source:

- `skills/root/nexus/SKILL.md.tmpl`

Generated compatibility output:

- `SKILL.md`

The root `/nexus` entrypoint has different install behavior from canonical,
support, safety, and alias skills: it is generated from the structured source
tree but mirrored at the repository root for host compatibility. Keeping this
source under `skills/root/nexus/` lets `lib/nexus/skill-structure.ts`,
`lib/nexus/host-roots.ts`, and the skill generator classify that behavior
explicitly instead of hiding it as a special case in `skills/canonical/` or
`skills/support/`.
