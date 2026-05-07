# Agents Compatibility Surface

`agents/` is intentionally a compatibility surface, not the active Codex host
source tree.

Active source:

- `hosts/codex/openai.yaml`

Compatibility path:

- `agents/openai.yaml`

Codex/OpenAI tooling still discovers root metadata through `agents/openai.yaml`,
so the single-child directory remains present even though the maintained source
lives under `hosts/codex/`. Do not add generated Codex skill output here;
generated skills belong under `.agents/skills/`.
