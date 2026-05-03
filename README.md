# Nexus

Nexus is a single-package AI engineering operating system.

Nexus is the only command surface.

Claude remains the only interactive front door.

It gives Claude one unified system for:

- product discovery and framing
- execution planning and governed handoff
- disciplined implementation
- dual-audit review
- QA validation
- release gating
- closeout and archival

Gstack host architecture, PM Skills, GSD, and Superpowers are absorbed into
Nexus-owned commands, stage content, and runtime contracts. CCB remains dispatch
and transport infrastructure only.

Nexus-owned stage packs remain the active internal runtime units. Imported
upstream repos remain source material only.
Upstream maintenance is handled by Nexus maintainers.
Users upgrade Nexus versions, not upstream repos.
`/nexus-upgrade` and automatic upgrade are the only user-facing update paths.
Release detection is channel-based through `release_channel` and published
`release.json` manifests. Managed installs are recorded as
`managed_release` or `managed_vendored`, and vendored copies sync to the same
published Nexus release as the managed global install.

## What Nexus owns

Nexus owns the active product and engineering semantics:

- commands
- lifecycle
- repo-visible state
- artifacts
- governance
- runtime orchestration
- project progression

Nexus does not rely on hidden conversational state as the source of truth.
Governed work is recorded in `lib/nexus/` and `.planning/`.

## Repository structure

Nexus generates host-specific skill output for four hosts: Claude
(`.claude/skills/`), Codex (`.agents/skills/`), Gemini CLI
(`.gemini/skills/`), and Factory (`.factory/skills/`). The four generated
trees are gitignored — they are produced by `bun run gen:skill-docs --host
<host>` from a single set of templates governed by a stricter taxonomy in
`lib/nexus/skill-structure.ts`:

- root entrypoint source: `skills/root/nexus/SKILL.md.tmpl`
- root entrypoint compatibility mirror: `SKILL.md`
- canonical lifecycle commands: `skills/canonical/<command>/`
- support workflows: `skills/support/<skill>/`
- safety workflows: `skills/safety/<skill>/`
- compatibility aliases: `skills/aliases/<alias>/`

Only the generated root `/nexus` compatibility mirror stays at the repository root. Migrated
reference sidecars now live under `references/`, while setup preserves installed
runtime paths such as `$NEXUS_ROOT/review/checklist.md`,
`$NEXUS_ROOT/review/specialists`, `$NEXUS_ROOT/design/references`, and
`$NEXUS_ROOT/cso/ACKNOWLEDGEMENTS.md` for generated skills.
`bun run skill:check` reports the active taxonomy so future source moves can be
reviewed before they affect installs.

The post-taxonomy-v2 layout is documented in
`docs/architecture/repo-taxonomy-v2.md`. The active roots include
`runtimes/` (executable browse / design / safety hooks), `references/`
(lazy-loaded checklists and templates), `vendor/` (absorbed upstream
snapshots and maintenance metadata), and `hosts/` (tracked host facade
sources for Claude / Codex / Gemini CLI / Factory). `hosts/gemini-cli/` and
`hosts/factory/` currently hold only facade READMEs; tracked host-specific
assets land there as they are added.

## How it runs

Nexus supports two explicit execution modes.

### `governed_ccb`

Use this when you want the full governed cross-provider path.

1. Make sure CCB providers are mounted for this repo
2. The standard way to start them is `tmux` → `ccb codex gemini claude`
3. Operate through Nexus from Claude once Codex/Gemini are mounted

**Human → Claude → Nexus → CCB → Codex/Gemini**

- the human interacts with Claude
- Claude invokes Nexus
- Nexus owns commands, lifecycle, artifacts, and governance
- Nexus dispatches external model work through CCB when needed
- review providers author attempt-scoped receipts under `.planning/current/review/attempts/<review_attempt_id>/`
- Nexus promotes the validated current attempt into `.planning/audits/current/`
- late stale replies stay in attempt receipts and do not overwrite canonical current audit truth
- repo-visible Nexus artifacts remain the only governed truth source

### `local_provider`

Use this when you do not want to install or run CCB.

**Human → Claude/Codex/Gemini → Nexus → local provider CLI**

- Nexus still owns commands, lifecycle, artifacts, and governance
- repo-visible Nexus artifacts remain the only lifecycle truth
- the active local runtime defaults to `single_agent`
- `claude + subagents` is an active local topology when `provider_topology=subagents`
- `codex + subagents` is an active local topology when `provider_topology=subagents`
- `codex + multi_session` is an active local topology when `provider_topology=multi_session`
- `gemini + subagents` is an active local topology when `provider_topology=subagents`
- non-Codex local `multi_session` still blocks at `/handoff`

## Quick start

1. Install Nexus into `~/.claude/skills/nexus`
2. Enter `/nexus` once at session start
3. Let Nexus confirm the active execution substrate:
   - `governed_ccb` when required CCB providers are actually mounted for this repo
   - `local_provider` when CCB is missing or not session-ready yet
4. Run `/discover`
5. Run `/frame`
6. Run `/plan`
7. Run `/handoff`
8. Run `/build`
9. Run `/review`
10. Run `/qa`
11. Run `/ship`
12. Run `/closeout`

Bare `/nexus` is the workflow-harness entrypoint, not the browser tool.
It should summarize:

- execution mode
- whether that route came from saved config or machine-state bootstrap
- mounted CCB providers and missing governed providers when CCB is relevant
- the current-host local fallback path when governed CCB is not ready

After that bootstrap, stay in the canonical lifecycle. Use `/browse` only when
you explicitly need browser QA.

Canonical lifecycle:

**Discover → Frame → Plan → Handoff → Build → Review → QA → Ship → Closeout**

A governed run ends at `/closeout`, but operational landing can happen before
or after closeout depending on team policy. If `/ship` recorded merge-ready PR
handoff metadata, use `/land` to merge without assuming deployment. Use
`/deploy` only after the PR is landed and the project has a real deploy surface.
`/land-and-deploy` remains the compatibility shortcut for teams that want one
command to ask merge-only vs merge+deploy. These are support workflows, not
additional canonical lifecycle stages. Deploy assumptions should live in
`.planning/deploy/`, not in `CLAUDE.md`.

## Install

**Base requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or another supported host, [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+, [Node.js](https://nodejs.org/) on Windows

**Additional governed-mode requirements:** [tmux](https://github.com/tmux/tmux/wiki) and [CCB](https://github.com/bfly123/claude_code_bridge)

### Step 1: Install Nexus on your machine

Fast path from the shell:

```bash
git clone --single-branch --depth 1 https://github.com/LaPaGaYo/nexus.git ~/.claude/skills/nexus
cd ~/.claude/skills/nexus && ./setup
```

If `~/.claude/skills/nexus` already exists, do not clone over it. Run `/nexus-upgrade` instead.

If setup is interactive in Claude and `ask` / CCB is missing, Nexus asks first
whether you want to install CCB now:

- install CCB now through the official `claude_code_bridge` installer, then continue setup
- continue without CCB and use `local_provider`

If CCB installation fails, setup stops there instead of silently falling through to a
governed or local execution choice.

If `ask` / CCB is already installed and setup is interactive in Claude, Nexus then asks
which path you want:

- continue in the current Claude session with `local_provider`
- switch to `governed_ccb` and make sure CCB providers are mounted, typically via `tmux` + `ccb codex gemini claude`

That choice is now explicit. Interactive Claude setup does not silently time out into
`local_provider` when CCB is present.

If you arrive through `/nexus-upgrade` instead of `./setup`, the first post-upgrade
Claude session now treats repo mode and execution mode separately:

- `repo mode` stays `solo` / `collaborative`
- `execution mode` stays `governed_ccb` / `local_provider`

If no explicit `execution_mode` is saved yet, Nexus states the effective default
execution path and, when CCB is already installed, asks whether to persist
`governed_ccb` or stay in the current Claude session with `local_provider`.
That summary should now also make the runtime gap explicit:

- `execution path` shows the effective route, for example `codex-via-ccb`
- `current session ready` tells you whether the chosen route is runnable right now
- governed summaries call out `mounted providers` and `missing providers`
- `CCB installed` and `providers mounted for this repo right now` are treated as separate states

If you choose `local_provider` in interactive Claude setup, Nexus then asks
which local Claude topology to use:

- `single_agent`
- `subagents`

Interactive Codex setup follows the same pattern, but the local subagent path is
role-specific Codex passes for build, review, and QA.
Interactive Codex setup also offers `multi_session` when the installed Codex CLI
exposes the required commands.

When `local_provider` uses a subagent-capable topology, `/review` fans out to
four Nexus-native local personas: code, test, security, and design. Persona
evidence is persisted under `.planning/current/review/persona-audits/`; the
canonical audit set remains `.planning/audits/current/` so closeout and
provenance checks stay compatible with governed CCB runs.

The same local-provider fallback applies at `/ship` with release-oriented
personas: release, QA, security, and docs/deploy. Their gate evidence is
persisted under `.planning/current/ship/persona-gates/`; any gate-affecting
failure records a blocked release gate instead of marking the run merge-ready.

If setup is non-interactive, the default remains:

- `governed_ccb` only when `ask` is installed and the required governed providers are actually mounted for this repo
- `local_provider` when CCB is missing or the governed route is not session-ready yet
- `single_agent` when `provider_topology` is not already configured

If neither CCB nor the selected local provider CLI is available, Nexus does not
silently continue. `/handoff` records a blocked route decision until you either
install CCB or configure a working local provider binary.

During interactive Claude installs, `./setup` can also offer to add a concise
Nexus-managed section to `~/.claude/CLAUDE.md` for cross-project defaults.
Project-specific workflow, architecture, and build instructions should stay in the
repository `CLAUDE.md`, rules, or skills.
Non-interactive installs skip that global file change by default.

If you want Claude to do the install for you, open Claude Code and paste this:

> Install Nexus. If **`~/.claude/skills/nexus`** does not exist, run **`git clone --single-branch --depth 1 https://github.com/LaPaGaYo/nexus.git ~/.claude/skills/nexus`**. If it already exists, run **`/nexus-upgrade`** instead. During setup, if CCB is missing, ask whether to install it before finalizing execution mode. After the install or upgrade finishes, make sure the global **`CLAUDE.md`** routes Claude through Nexus. If setup did not already offer to update it, add a **`Nexus`** section that says:
>
> - Claude is the only interactive front door.
> - When a repository exposes canonical Nexus commands, route lifecycle work through **`/discover`**, **`/frame`**, **`/plan`**, **`/handoff`**, **`/build`**, **`/review`**, **`/qa`**, **`/ship`**, and **`/closeout`**.
> - Keep global **`CLAUDE.md`** limited to cross-project defaults. Keep project-specific workflow and architecture in the repository **`CLAUDE.md`**, **`hosts/claude/rules/`**, or skills. **`.claude/rules/`** remains the Claude discovery compatibility surface.
> - Use **`/browse`** from Nexus for all web browsing.
> - Never use **`mcp__claude-in-chrome__*`** tools unless the user explicitly asks for them.
> - Legacy aliases **`/office-hours`**, **`/plan-ceo-review`**, **`/plan-eng-review`**, and **`/autoplan`** are compatibility-only.
>
> Then ask the user if they also want to add Nexus to the current project so teammates get it.

### Choose or override execution mode

Nexus reads execution defaults from `~/.nexus/config.yaml` via `nexus-config`:

```bash
nexus-config set execution_mode governed_ccb
nexus-config set execution_mode local_provider
nexus-config set primary_provider claude
nexus-config set primary_provider codex
nexus-config set primary_provider gemini
nexus-config set provider_topology single_agent
nexus-config set provider_topology subagents
nexus-config set provider_topology multi_session
```

Use this to inspect the effective execution route without guessing from partial config:

```bash
nexus-config effective-execution
```

For governed runs, this now reports:

- the effective execution path
- whether the current session is ready right now
- whether governed CCB is ready
- which providers are mounted
- which providers are still missing

Mode-specific rule:

- `governed_ccb`: normally only persist `execution_mode`; `primary_provider` and `provider_topology` are local-provider-only host preferences and may stay unset
- `local_provider`: persist `primary_provider` and `provider_topology` when you want a non-default local provider or topology
- governed requested/actual route truth lives in canonical `.planning/` artifacts, not in `~/.nexus/config.yaml`

Practical defaults:

- interactive Claude setup requires an explicit mode choice when `ask` is installed and no explicit mode is saved
- the first Claude session after `/nexus-upgrade` now also makes repo mode and execution mode explicit when no mode is saved yet
- interactive Claude setup asks whether to install CCB when `ask` is missing and no explicit local choice is already saved
- interactive Claude setup also asks `single_agent` vs `subagents` when `local_provider` is selected for Claude
- interactive Codex setup asks `single_agent` vs `subagents` vs `multi_session` when `local_provider` is selected for Codex
- Gemini local subagents are supported through `nexus-config set primary_provider gemini` plus `nexus-config set provider_topology subagents`
- non-interactive defaults only choose `governed_ccb` when `ask` is installed and the required governed providers are actually mounted
- otherwise the machine-state default is `local_provider` for the current host session
- `primary_provider` auto-detects `claude`, then `codex`, then `gemini`

### Step 2: Add Nexus to your repo so teammates get it

Optional, but recommended for team consistency.

Shell path:

```bash
mkdir -p .claude/skills
rsync -a --delete --exclude '.git' ~/.claude/skills/nexus/ .claude/skills/nexus/
cd .claude/skills/nexus && ./setup
```

This must be a real repo copy, not a submodule and not just a symlink.

Then update the project `CLAUDE.md` so it stays Nexus-first, and use `hosts/claude/rules/` for heavier or path-scoped project guidance. `.claude/rules/` remains a compatibility surface for Claude discovery. Canonical lifecycle commands come first, `/browse` stays the web tool, `mcp__claude-in-chrome__*` stays disallowed unless explicitly requested, and legacy aliases are documented only as compatibility entries.

### Other hosts

Install for Codex-compatible hosts. Two install modes — pick the one that matches your team's setup:

- **Global** (`~/nexus`) — single Nexus install shared across all your projects. Use this when you work alone or when teammates manage their own Nexus install separately. Lower disk usage, single upgrade point.
- **Repo-local** (`.agents/skills/nexus`) — Nexus lives inside the project repo's Codex sidecar tree. Use this when you want every contributor in a repo to get the exact same Nexus version pinned to that branch (similar to vendoring a dependency). Slightly larger repo footprint, version-controlled.

If you're unsure, start with **global** — switch to repo-local later if your team needs version pinning.

#### Global install

```bash
git clone --single-branch --depth 1 https://github.com/LaPaGaYo/nexus.git ~/nexus
cd ~/nexus && ./setup --host codex
```

#### Repo-local install

```bash
git clone --single-branch --depth 1 https://github.com/LaPaGaYo/nexus.git .agents/skills/nexus
cd .agents/skills/nexus && ./setup --host codex
```

If you want Codex to do the install for you, open Codex and paste this:

> Install Nexus for Codex. If **`/nexus-upgrade`** is already available, run it. Otherwise, if **`.agents/skills/nexus`** exists in this repo, run **`cd .agents/skills/nexus && ./setup --host codex`**. If it does not exist and **`~/nexus`** does not exist yet, run **`git clone --single-branch --depth 1 https://github.com/LaPaGaYo/nexus.git ~/nexus`**, then **`cd ~/nexus && ./setup --host codex`**. After setup finishes, tell the user where the installed **`nexus-*`** skills live, which execution mode and local topology are selected, and remind them that Codex does not use a Nexus-managed global instruction file equivalent to **`~/.claude/CLAUDE.md`**.

Codex does not use a Nexus-managed global instruction file equivalent to **`~/.claude/CLAUDE.md`**.

Let setup auto-detect installed hosts:

```bash
git clone --single-branch --depth 1 https://github.com/LaPaGaYo/nexus.git ~/nexus
cd ~/nexus && ./setup --host auto
```

Factory Droid:

```bash
git clone --single-branch --depth 1 https://github.com/LaPaGaYo/nexus.git ~/nexus
cd ~/nexus && ./setup --host factory
```

## Canonical lifecycle commands

| Skill | Role | What it does |
|-------|------|--------------|
| `/discover` | PM discovery | Clarify the problem, goals, constraints, and missing context. |
| `/frame` | PM framing | Classify design impact, lock scope, non-goals, success criteria, and the product brief. |
| `/plan` | GSD planning | Convert approved framing into execution-ready planning artifacts, including the canonical verification matrix, and require a design contract for material UI work. |
| `/handoff` | Governed routing | Record approved provider routing, substrate, provenance intent, and fallback policy. |
| `/build` | Disciplined execution | Run the bounded implementation contract and persist the build result. |
| `/review` | Dual audit | Promote provider-authored review receipts into the canonical audit set, synthesis, and reviewed provenance. |
| `/qa` | Validation | Record explicit validation scope, findings, and visual verification before `/ship` for design-bearing runs. |
| `/ship` | Release gate | Record conservative release readiness, checklist state, and PR handoff metadata when available. |
| `/closeout` | Milestone verification | Verify archive, provenance, legality, and final readiness status. |

For design-bearing runs, `/frame` classifies design impact, `/plan` writes the canonical verification matrix and requires a design contract for material UI work, and `/qa` records visual verification before `/ship` for design-bearing runs.

Each canonical stage from `/frame` through `/closeout` now also writes
`.planning/current/<stage>/completion-advisor.json`. That advisor is the
runtime-owned next-step contract for interactive hosts: it carries the primary
next action, `interaction_mode`, any required user choice, a `stop_action`,
project setup gaps, recommended side skills, and the short descriptions that
should back stage-completion prompts.

Direct CLI users can also run any stage with `--output interactive` to print a
host-independent chooser from the same advisor record. That path is for shells
or hosts that cannot show `AskUserQuestion`; it does not auto-execute the
selected command.

Design-bearing runs use that advisor to surface design-aware follow-on work.
That means `/plan-design-review`, `/design-review`, and `/browse` appear when
`design_impact` and the verification matrix say they matter, while compatibility
aliases and session utility skills stay hidden from stage-completion prompts.
Each surfaced action also carries a `visibility_reason`, so the host can explain
why that support skill is being recommended now instead of treating it like a
flat menu.

Nexus can also see user-installed skills without making them part of the
canonical lifecycle. It scans installed `SKILL.md` files, classifies them as
Nexus canonical, Nexus support, or external installed skills, and only surfaces
external skills as supplemental actions when their tags match the current stage
and run context. Nexus canonical commands always win name conflicts. Built-in
Nexus support skills, such as `/design-review`, `/browse`, `/simplify`, `/benchmark`,
and `/cso`, are shown before external installed skills. External recommendations
are written separately as `recommended_external_skills` so hosts can display
them without confusing them with Nexus-owned workflow actions.

Fresh `/discover` also accepts an explicit continuation hint when you are
starting the next run:

```bash
bun run bin/nexus.ts discover --continuation-mode task
```

Supported values are `task`, `phase`, and `project_reset`. Automation can use
the same override through `NEXUS_CONTINUATION_MODE`.

Lifecycle continuation does not require a fresh session. Nexus can continue in
the current session. That is a lifecycle rule, not a session-quality
guarantee.

When recent repo retros exist under `.planning/archive/retros/`, fresh
`/discover` may also surface retro continuity context alongside the normal
next-run bootstrap and session advice.

When setup or a fresh-run discover boundary emits session continuation advice,
the three user-facing paths are:

- continue here (`continue_here`)
- compact this session and continue (`compact_then_continue`)
- start a fresh session and run `/continue` (`fresh_session_continue`)

Use `/continue` when you want to resume from a fresh session and reload the
latest repo-visible context transfer files.

Legacy aliases remain compatibility-only:

- `/office-hours -> /discover`
- `/plan-ceo-review -> /frame`
- `/plan-eng-review -> /frame`
- `/autoplan -> /plan`

## See it work

```text
You:    /discover
Claude: clarifies the problem, constraints, goals, and unknowns

You:    /frame
Claude: locks scope, non-goals, success criteria, and product shape

You:    /plan
Claude: writes execution-readiness artifacts and the canonical verification matrix

You:    /handoff
Claude: freezes governed routing, provider intent, and fallback policy

You:    /build
Claude: executes the bounded implementation contract and records build state

You:    /review
Claude: writes the governed audit set and reviewed provenance

You:    /qa
Claude: records validation scope and defects

You:    /ship
Claude: writes conservative release-gate state

You:    /closeout
Claude: verifies archive, provenance, and final work-unit readiness
```

## Nexus support surface

| Skill | What it does |
|-------|-------------|
| `/browse` | Real browser control for QA, capture, and site workflows. |
| `/connect-chrome` | Launch Chrome with Nexus Side Panel control. |
| `/setup-browser-cookies` | Import browser sessions for authenticated QA. |
| `/design-consultation` | Create integrated design context and deliverable direction for UI, prototypes, decks, motion, and infographics. |
| `/design-shotgun` | Generate and compare multiple design directions for UI screens, prototypes, decks, motion boards, and infographics. |
| `/design-html` | Turn approved mockups into production HTML while honoring frozen design and brand context. |
| `/design-review` | Audit and polish the visual result in code using the integrated five-lens design critique. |
| `/simplify` | Run a behavior-preserving simplification pass for maintainability and complexity advisories. |
| `/investigate` | Systematic root-cause debugging. |
| `/document-release` | Sync docs after shipping and attach `.planning/current/closeout/documentation-sync.md`. |
| `/retro` | Project or global retrospective. Repo-scoped retros archive to `.planning/archive/retros/` and can feed fresh-run continuity. |
| `/land` | Merge a PR from the `/ship` handoff without assuming deployment, and record merge-only landing evidence in `.planning/current/ship/deploy-result.json`. |
| `/deploy` | Deploy and verify an already-landed change when the project has a production deploy surface. |
| `/land-and-deploy` | Compatibility shortcut that lands a PR and optionally continues into deploy verification. |
| `/canary` | Post-deploy health monitoring attached to ship follow-on evidence via `.planning/current/ship/canary-status.json`. |
| `/benchmark` | Performance baselining and regression checks attached to QA follow-on evidence via `.planning/current/qa/perf-verification.md`. |
| `/cso` | Security review and threat analysis. |
| `/careful` | Warn before destructive operations. |
| `/freeze` | Restrict edits to one directory. |
| `/guard` | Combine destructive-command warnings and edit freeze. |
| `/unfreeze` | Remove the edit freeze. |
| `/setup-deploy` | Author the canonical deploy contract in `.planning/deploy/`, including primary and secondary deploy surfaces, for `/ship`, `/deploy`, and `/land-and-deploy`. |
| `/nexus-upgrade` | Upgrade Nexus through the supported release-based user-facing update flow. |
| `/learn` | Manage project learnings across sessions. |
| `/qa-only` | Run QA in report-only mode as attached evidence without changing canonical lifecycle state. |
| `/codex` | Independent second-opinion review through Codex. |

The absorbed Nexus design runtime under `runtimes/design/` now supports five deliverable
classes: `ui-mockup`, `prototype`, `slides`, `motion`, and `infographic`.
It also ships internal export and verification pipelines for HTML, PDF,
editable PPTX, MP4, GIF, and Playwright-based HTML verification without
exposing a second design product surface.

Deep dives and usage examples live in [docs/skills.md](docs/skills.md).

Governed runs may publish canonical learnings at `/closeout`.
`/learn` surfaces both operational JSONL learnings and canonical run learnings when available.
`/closeout` also assembles `.planning/current/closeout/FOLLOW-ON-SUMMARY.md`
and `.planning/current/closeout/follow-on-summary.json` so follow-on support
evidence has a single repo-visible index for archive, discover, retro, and
learn flows.

`/land`, `/deploy`, and `/land-and-deploy` are intentionally post-lifecycle.
`/land` consumes the PR handoff written by `/ship`, waits for CI, asks before
merge, and records merge-only landing evidence. `/deploy` consumes the landing
evidence plus the canonical deploy contract written by `/setup-deploy`, verifies
the production surface, and can be followed by `/canary` when a URL exists.
`/land-and-deploy` remains a compatibility shortcut that asks whether this PR is
`merge + deploy` or `merge only, no deploy needed`. When CI fails, a merge
conflict appears, or merge-queue validation fails, landing evidence tells you
whether the next step is `rerun_land`, `rerun_ship`, or a governed fix cycle
back through `/build -> /review -> /qa -> /ship`. Early or unstable projects
do not get `/deploy`, `/land-and-deploy`, or `/setup-deploy` forced into the
flow; `/setup-deploy` is surfaced only when deployment readiness is part of the
verification matrix or the user explicitly asks for it.

## Maintainer helpers

These are not lifecycle stages, but they are now canonical maintainer and
repair entrypoints:

- `./bin/nexus-release-publish` or `bun run release:publish`
  - atomic publish path for a prepared release candidate
- `./bin/nexus-ledger-doctor` or `bun run ledger:doctor`
  - report-only diagnosis for noncanonical history and stale current audits

## Governed truth model

Nexus treats the repository as the system of record.

- canonical lifecycle truth lives in `lib/nexus/`
- governed artifacts live in `.planning/`
- backend outputs become truth only after Nexus normalization and writeback
- requested route and actual route are recorded separately
- closeout verifies legality, provenance, archive state, and readiness

This is what keeps the workflow governed instead of conversationally implicit.

## CCB integration

CCB is connected as infrastructure, not as product ownership.

- CCB provides provider dispatch and transport
- Nexus decides lifecycle, route approval, artifacts, and governance
- Codex and Gemini can be used through CCB without becoming contract owners

The intended usage pattern is:

1. Start `tmux`
2. Start `ccb claude codex gemini`
3. Enter Claude
4. Run work through Nexus

## Docs

| Doc | What it covers |
|-----|---------------|
| [Skill Deep Dives](docs/skills.md) | Detailed behavior and examples for the skill surface |
| [Architecture](ARCHITECTURE.md) | System structure and implementation notes |
| [Contributing](CONTRIBUTING.md) | Dev setup, testing, and contributor workflows |
| [Changelog](CHANGELOG.md) | Version history |
| [Release Notes](docs/releases/2026-04-26-nexus-v1.0.46.md) | Nexus v1.0.46 release notes |

## Troubleshooting

**Skill not showing up?**

```bash
cd ~/.claude/skills/nexus && ./setup
```

**`/browse` fails?**

```bash
cd ~/.claude/skills/nexus && bun install && bun run build
```

**Stale install?**

Run `/nexus-upgrade` or set `auto_upgrade: true` in `~/.nexus/config.yaml`.
Upgrade checks follow the configured `release_channel` and published release
metadata, not upstream repo heads.

**State seems inconsistent after retries or manual intervention?**

```bash
bun run ledger:doctor
```

This reports noncanonical closeout history and stale `.planning/audits/current`
state without mutating the repo.

**Want shorter commands?**

```bash
cd ~/.claude/skills/nexus && ./setup --no-prefix
```

**Want namespaced commands?**

```bash
cd ~/.claude/skills/nexus && ./setup --prefix
```

**Codex says a SKILL.md is invalid?**

```bash
/nexus-upgrade
```

For repo-local Codex installs:

```bash
/nexus-upgrade
```

**Claude cannot see the skills?**

Make sure your `CLAUDE.md` contains a Nexus section that routes lifecycle work
through `/discover`, `/frame`, `/plan`, `/handoff`, `/build`, `/review`,
`/qa`, `/ship`, and `/closeout`, uses `/browse` for web work, and treats legacy
aliases as compatibility-only.

## Privacy

Nexus does not ship usage telemetry.

- no remote analytics backend
- no background usage reporting
- no install-base pings through Supabase
- if Nexus breaks, file an issue or PR on GitHub instead

Configuration lives under `~/.nexus/config.yaml`.

## License

MIT. Free forever. Go build something.
