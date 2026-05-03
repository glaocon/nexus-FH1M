import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import {
  deployContractJsonPath,
  qaPerfVerificationPath,
  shipDeployReadinessPath,
  shipLearningCandidatesPath,
  shipPullRequestPath,
} from '../../lib/nexus/artifacts';
import { makeFakeAdapters } from './helpers/fake-adapters';
import { runInTempRepo } from './helpers/temp-repo';
import { resolveInvocation } from '../../lib/nexus/commands';
import { resolveShipPullRequest } from '../../lib/nexus/ship-pull-request';
import type { NexusCommandRunner } from '../../lib/nexus/command-runner';

describe('nexus ship', () => {
  test('blocks ship when the verification matrix requires QA and no QA stage has been recorded', async () => {
    await runInTempRepo(async ({ run }) => {
      const adapters = makeFakeAdapters({
        pm: {
          frame: async () => ({
            adapter_id: 'pm',
            outcome: 'success',
            raw_output: {
              decision_brief_markdown: '# Decision Brief\n\nScope: ship QA matrix gate\n',
              prd_markdown: '# PRD\n\nSuccess criteria: ship QA matrix gate\n',
              design_intent: {
                impact: 'none',
                affected_surfaces: [],
                design_system_source: 'none',
                contract_required: false,
                verification_required: true,
              },
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-frame-pack',
              absorbed_capability: 'pm-frame',
              source_map: ['vendor/upstream/pm-skills/commands/write-prd.md'],
            },
          }),
        },
        gsd: {
          plan: async () => ({
            adapter_id: 'gsd',
            outcome: 'success',
            raw_output: {
              execution_readiness_packet: '# Execution Readiness Packet\n\nReady\n',
              sprint_contract: '# Sprint Contract\n\nMatrix QA required\n',
              ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-plan-pack',
              absorbed_capability: 'gsd-plan',
              source_map: ['vendor/upstream/gsd/commands/gsd/plan-phase.md'],
            },
          }),
        },
      });

      await run('discover');
      await run('frame', adapters);
      await run('plan', adapters);
      await run('handoff');
      await run('build');
      await run('review');

      await expect(run('ship')).rejects.toThrow(
        'QA is required by the verification matrix before ship',
      );
    });
  });

  test('blocks design-bearing runs without design verification', async () => {
    await runInTempRepo(async ({ run }) => {
      const adapters = makeFakeAdapters({
        pm: {
          frame: async () => ({
            adapter_id: 'pm',
            outcome: 'success',
            raw_output: {
              decision_brief_markdown: '# Decision Brief\n\nScope: touchup ship gate\n',
              prd_markdown: '# PRD\n\nSuccess criteria: touchup ship gate\n',
              design_intent: {
                impact: 'touchup',
                affected_surfaces: ['apps/web/src/app/page.tsx'],
                design_system_source: 'design_md',
                contract_required: false,
                verification_required: true,
              },
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-frame-pack',
              absorbed_capability: 'pm-frame',
              source_map: ['vendor/upstream/pm-skills/commands/write-prd.md'],
            },
          }),
        },
        gsd: {
          plan: async () => ({
            adapter_id: 'gsd',
            outcome: 'success',
            raw_output: {
              execution_readiness_packet: '# Execution Readiness Packet\n\nReady\n',
              sprint_contract: '# Sprint Contract\n\nTouchup\n',
              ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-plan-pack',
              absorbed_capability: 'gsd-plan',
              source_map: ['vendor/upstream/gsd/commands/gsd/plan-phase.md'],
            },
          }),
        },
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      await run('discover');
      await run('frame', adapters);
      await run('plan', adapters);
      await run('handoff');
      await run('build');
      await run('review');

      await expect(run('ship', adapters)).rejects.toThrow(
        'QA is required by the verification matrix before ship',
      );
    });
  });

  test('does not block when review and QA provenance are non-design', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      const frameAdapters = makeFakeAdapters({
        pm: {
          frame: async () => ({
            adapter_id: 'pm',
            outcome: 'success',
            raw_output: {
              decision_brief_markdown: '# Decision Brief\n\nScope: material ship gate fallback check\n',
              prd_markdown: '# PRD\n\nSuccess criteria: material ship gate fallback check\n',
              design_intent: {
                impact: 'material',
                affected_surfaces: ['apps/web/src/app/page.tsx'],
                design_system_source: 'design_md',
                contract_required: true,
                verification_required: true,
              },
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-frame-pack',
              absorbed_capability: 'pm-frame',
              source_map: ['vendor/upstream/pm-skills/commands/write-prd.md'],
            },
          }),
        },
        gsd: {
          plan: async () => ({
            adapter_id: 'gsd',
            outcome: 'success',
            raw_output: {
              execution_readiness_packet: '# Execution Readiness Packet\n\nReady\n',
              sprint_contract: '# Sprint Contract\n\nMaterial\n',
              design_contract: '# Design Contract\n\nMaterial UI constraints\n',
              ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-plan-pack',
              absorbed_capability: 'gsd-plan',
              source_map: ['vendor/upstream/gsd/commands/gsd/plan-phase.md'],
            },
          }),
        },
      });

      await run('discover');
      await run('frame', frameAdapters);
      await run('plan', frameAdapters);
      await run('handoff');
      await run('build');
      await run('review');

      const reviewStatusPath = join(cwd, '.planning/current/review/status.json');
      const reviewStatus = await run.readJson('.planning/current/review/status.json');
      reviewStatus.design_impact = 'none';
      reviewStatus.design_contract_path = null;
      reviewStatus.design_verified = null;
      writeFileSync(reviewStatusPath, JSON.stringify(reviewStatus, null, 2) + '\n');

      const qaAdapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: pass\n',
              ready: true,
              findings: [],
              receipt: 'qa-pass',
            },
            requested_route: ctx.requested_route,
            actual_route: {
              provider: 'gemini',
              route: ctx.requested_route?.generator ?? 'gemini-via-ccb',
              substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
              transport: 'ccb',
              receipt_path: '.planning/current/qa/adapter-output.json',
            },
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-qa-pack',
              absorbed_capability: 'ccb-qa',
              source_map: ['vendor/upstream/claude-code-bridge/lib/gemini_comm.py'],
            },
          }),
        },
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      await run('qa', qaAdapters);
      await run('ship', qaAdapters);

      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        stage: 'ship',
        state: 'completed',
        ready: true,
        design_impact: 'none',
        design_contract_path: null,
        design_verified: true,
      });
      expect(await run.readJson('.planning/current/ship/checklist.json')).toMatchObject({
        design_impact: 'none',
        design_contract_path: null,
        design_verified: true,
        design_verification_path: '.planning/current/qa/design-verification.md',
      });
    });
  });

  test('writes deploy readiness from canonical deploy contract', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const contractPath = deployContractJsonPath();
      mkdirSync(join(cwd, '.planning/deploy'), { recursive: true });
      writeFileSync(join(cwd, contractPath), JSON.stringify({
        schema_version: 1,
        configured_at: '2026-04-17T00:00:00.000Z',
        primary_surface_label: 'web',
        platform: 'fly',
        project_type: 'web_app',
        production: {
          url: 'https://test-app.fly.dev',
          health_check: 'https://test-app.fly.dev/health',
        },
        staging: {
          url: 'https://staging.test-app.fly.dev',
          workflow: '.github/workflows/staging.yml',
        },
        deploy_trigger: {
          kind: 'auto_on_push',
          details: 'merge to main deploys automatically',
        },
        deploy_workflow: '.github/workflows/deploy.yml',
        deploy_status: {
          kind: 'command',
          command: 'fly status --app test-app',
        },
        custom_hooks: {
          pre_merge: ['bun test'],
          post_merge: [],
        },
        secondary_surfaces: [
          {
            label: 'worker',
            platform: 'github_actions',
            project_type: 'service',
            production: {
              url: null,
              health_check: null,
            },
            deploy_trigger: {
              kind: 'github_actions',
              details: '.github/workflows/worker-deploy.yml',
            },
            deploy_workflow: '.github/workflows/worker-deploy.yml',
            deploy_status: {
              kind: 'github_actions',
              command: null,
            },
            notes: ['Optional worker deploy path.'],
            sources: ['.github/workflows/worker-deploy.yml'],
          },
        ],
        notes: [],
        sources: ['fly.toml', '.github/workflows/deploy.yml'],
      }, null, 2) + '\n');

      await run('ship');

      expect(await run.readJson(shipDeployReadinessPath())).toMatchObject({
        configured: true,
        source: 'canonical_contract',
        contract_path: contractPath,
        primary_surface_label: 'web',
        platform: 'fly',
        project_type: 'web_app',
        production_url: 'https://test-app.fly.dev',
        health_check: 'https://test-app.fly.dev/health',
        deploy_status_kind: 'command',
        deploy_status_command: 'fly status --app test-app',
        deploy_workflow: '.github/workflows/deploy.yml',
        staging_detected: true,
        secondary_surfaces: [
          expect.objectContaining({
            label: 'worker',
            platform: 'github_actions',
            project_type: 'service',
            deploy_workflow: '.github/workflows/worker-deploy.yml',
            blocking: false,
          }),
        ],
      });
      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        outputs: expect.arrayContaining([
          expect.objectContaining({ path: shipDeployReadinessPath(), kind: 'json' }),
        ]),
      });
    });
  });

  test('writes deploy readiness from legacy CLAUDE.md deploy config when canonical contract is absent', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      writeFileSync(join(cwd, 'CLAUDE.md'), `# Project Instructions

## Deploy Configuration (configured by /setup-deploy)
- Platform: fly
- Production URL: https://legacy-app.fly.dev
- Deploy workflow: auto-deploy on push
- Deploy status command: fly status --app legacy-app
- Merge method: squash
- Project type: web app
- Post-deploy health check: https://legacy-app.fly.dev/health

### Custom deploy hooks
- Pre-merge: bun test
- Deploy trigger: automatic on push to main
- Deploy status: fly status --app legacy-app
- Health check: https://legacy-app.fly.dev/health
`);

      await run('ship');

      expect(await run.readJson(shipDeployReadinessPath())).toMatchObject({
        configured: true,
        source: 'legacy_claude',
        contract_path: null,
        platform: 'fly',
        project_type: 'web_app',
        production_url: 'https://legacy-app.fly.dev',
        health_check: 'https://legacy-app.fly.dev/health',
        deploy_status_kind: 'command',
        deploy_status_command: 'fly status --app legacy-app',
      });
    });
  });

  test('reads attached QA perf verification evidence into ship inputs and release gate record', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');
      await run('qa');

      writeFileSync(
        join(cwd, qaPerfVerificationPath()),
        '# Perf Verification\n\n- p95 latency regressed: no\n',
      );

      await run('ship');

      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        inputs: expect.arrayContaining([
          expect.objectContaining({ path: qaPerfVerificationPath(), kind: 'markdown' }),
        ]),
      });
      expect(await run.readFile('.planning/current/ship/release-gate-record.md')).toContain(
        'QA performance verification: .planning/current/qa/perf-verification.md',
      );
    });
  });

  test('creates a pull request record when merge is ready and no PR exists yet', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const commands: string[] = [];
      let prViewCount = 0;
      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      const invocation = resolveInvocation('ship');
      await invocation.handler({
        cwd,
        clock: () => new Date().toISOString(),
        via: invocation.via,
        adapters,
        execution: {
          mode: 'governed_ccb',
          primary_provider: 'codex',
          provider_topology: 'multi_session',
          requested_execution_path: 'codex-via-ccb',
        },
        run_command: async (spec) => {
          commands.push(spec.argv.join(' '));

          if (spec.argv[0] === 'git' && spec.argv[1] === 'branch') {
            return { exitCode: 0, stdout: 'feature/phase-2-auth\n', stderr: '' };
          }

          if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-parse' && spec.argv[2] === 'HEAD') {
            return { exitCode: 0, stdout: 'abc123def456\n', stderr: '' };
          }

          if (
            spec.argv[0] === 'git'
            && spec.argv[1] === 'rev-parse'
            && spec.argv[2] === '--abbrev-ref'
          ) {
            return { exitCode: 0, stdout: 'origin/feature/phase-2-auth\n', stderr: '' };
          }

          if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-list') {
            return { exitCode: 0, stdout: '0\t0\n', stderr: '' };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'view') {
            prViewCount += 1;
            if (prViewCount === 1) {
              return { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "feature/phase-2-auth"\n' };
            }

            return {
              exitCode: 0,
              stdout: JSON.stringify({
                number: 123,
                url: 'https://github.com/LaPaGaYo/project-tracker/pull/123',
                state: 'OPEN',
                headRefName: 'feature/phase-2-auth',
                headRefOid: 'abc123def456',
                baseRefName: 'main',
              }),
              stderr: '',
            };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'repo' && spec.argv[2] === 'view') {
            return { exitCode: 0, stdout: 'main\n', stderr: '' };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'create') {
            return {
              exitCode: 0,
              stdout: 'https://github.com/LaPaGaYo/project-tracker/pull/123\n',
              stderr: '',
            };
          }

          throw new Error(`unexpected command: ${spec.argv.join(' ')}`);
        },
      });

      expect(await run.readJson('.planning/current/ship/pull-request.json')).toMatchObject({
        status: 'created',
        provider: 'github',
        number: 123,
        url: 'https://github.com/LaPaGaYo/project-tracker/pull/123',
        head_branch: 'feature/phase-2-auth',
        head_sha: 'abc123def456',
        base_branch: 'main',
      });
      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        stage: 'ship',
        ready: true,
        pull_request: {
          status: 'created',
          number: 123,
          head_sha: 'abc123def456',
        },
      });
      expect(await run.readJson(shipPullRequestPath())).toMatchObject({
        head_sha: 'abc123def456',
      });
      expect(commands).toEqual([
        'git branch --show-current',
        'git rev-parse HEAD',
        'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
        'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
        'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
        'git rev-list --left-right --count @{u}...HEAD',
        'gh pr create --base main --head feature/phase-2-auth --fill',
        'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      ]);
    });
  });

  test('creates pull request handoff from the execution workspace instead of the repo root', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      writeFileSync(join(cwd, 'README.md'), '# temp repo\n');
      expect(spawnSync('git', ['init', '-b', 'main'], { cwd, stdio: 'pipe' }).status).toBe(0);
      expect(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' }).status).toBe(0);
      expect(spawnSync('git', ['config', 'user.name', 'Nexus Test'], { cwd, stdio: 'pipe' }).status).toBe(0);
      expect(spawnSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' }).status).toBe(0);
      expect(spawnSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' }).status).toBe(0);

      const workspacePath = join(cwd, '.nexus-worktrees/run-ship-workspace');
      expect(
        spawnSync('git', ['worktree', 'add', workspacePath, '-b', 'codex/run-phase-4'], {
          cwd,
          stdio: 'pipe',
        }).status,
      ).toBe(0);
      const canonicalWorkspacePath = realpathSync.native(workspacePath);

      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const reviewStatusPath = join(cwd, '.planning/current/review/status.json');
      const reviewStatus = JSON.parse(readFileSync(reviewStatusPath, 'utf8'));
      writeFileSync(
        reviewStatusPath,
        JSON.stringify(
          {
            ...reviewStatus,
            workspace: {
              path: canonicalWorkspacePath,
              kind: 'worktree',
              branch: 'codex/run-phase-4',
              source: 'existing:nexus_worktree',
            },
          },
          null,
          2,
        ) + '\n',
      );

      const commands: Array<{ cwd: string; argv: string[] }> = [];
      let prViewCount = 0;
      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      const invocation = resolveInvocation('ship');
      await invocation.handler({
        cwd,
        clock: () => new Date().toISOString(),
        via: invocation.via,
        adapters,
        execution: {
          mode: 'governed_ccb',
          primary_provider: 'codex',
          provider_topology: 'multi_session',
          requested_execution_path: 'codex-via-ccb',
        },
        run_command: async (spec) => {
          commands.push({ cwd: spec.cwd, argv: spec.argv });

          if (spec.argv[0] === 'git' && spec.argv[1] === 'branch') {
            expect(spec.cwd).toBe(canonicalWorkspacePath);
            return { exitCode: 0, stdout: 'codex/run-phase-4\n', stderr: '' };
          }

          if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-parse' && spec.argv[2] === 'HEAD') {
            expect(spec.cwd).toBe(canonicalWorkspacePath);
            return { exitCode: 0, stdout: 'runworkspace123\n', stderr: '' };
          }

          if (
            spec.argv[0] === 'git'
            && spec.argv[1] === 'rev-parse'
            && spec.argv[2] === '--abbrev-ref'
          ) {
            expect(spec.cwd).toBe(canonicalWorkspacePath);
            return { exitCode: 0, stdout: 'origin/codex/run-phase-4\n', stderr: '' };
          }

          if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-list') {
            expect(spec.cwd).toBe(canonicalWorkspacePath);
            return { exitCode: 0, stdout: '0\t0\n', stderr: '' };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'view') {
            expect(spec.cwd).toBe(canonicalWorkspacePath);
            prViewCount += 1;
            if (prViewCount === 1) {
              return { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "codex/run-phase-4"\n' };
            }

            return {
              exitCode: 0,
              stdout: JSON.stringify({
                number: 456,
                url: 'https://github.com/LaPaGaYo/project-tracker/pull/456',
                state: 'OPEN',
                headRefName: 'codex/run-phase-4',
                headRefOid: 'runworkspace123',
                baseRefName: 'main',
              }),
              stderr: '',
            };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'repo' && spec.argv[2] === 'view') {
            expect(spec.cwd).toBe(canonicalWorkspacePath);
            return { exitCode: 0, stdout: 'main\n', stderr: '' };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'create') {
            expect(spec.cwd).toBe(canonicalWorkspacePath);
            return {
              exitCode: 0,
              stdout: 'https://github.com/LaPaGaYo/project-tracker/pull/456\n',
              stderr: '',
            };
          }

          throw new Error(`unexpected command: ${spec.argv.join(' ')}`);
        },
      });

      expect(await run.readJson('.planning/current/ship/pull-request.json')).toMatchObject({
        status: 'created',
        provider: 'github',
        number: 456,
        url: 'https://github.com/LaPaGaYo/project-tracker/pull/456',
        head_branch: 'codex/run-phase-4',
        head_sha: 'runworkspace123',
        base_branch: 'main',
      });
      expect(commands.map((command) => `${command.cwd}::${command.argv.join(' ')}`)).toEqual([
        `${canonicalWorkspacePath}::git branch --show-current`,
        `${canonicalWorkspacePath}::git rev-parse HEAD`,
        `${canonicalWorkspacePath}::gh pr view --json number,url,state,headRefName,headRefOid,baseRefName`,
        `${canonicalWorkspacePath}::gh repo view --json defaultBranchRef -q .defaultBranchRef.name`,
        `${canonicalWorkspacePath}::git rev-parse --abbrev-ref --symbolic-full-name @{u}`,
        `${canonicalWorkspacePath}::git rev-list --left-right --count @{u}...HEAD`,
        `${canonicalWorkspacePath}::gh pr create --base main --head codex/run-phase-4 --fill`,
        `${canonicalWorkspacePath}::gh pr view --json number,url,state,headRefName,headRefOid,baseRefName`,
      ]);
    });
  });

  test('reuses an existing pull request record when the current branch already has one', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const commands: string[] = [];
      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      const invocation = resolveInvocation('ship');
      await invocation.handler({
        cwd,
        clock: () => new Date().toISOString(),
        via: invocation.via,
        adapters,
        execution: {
          mode: 'governed_ccb',
          primary_provider: 'codex',
          provider_topology: 'multi_session',
          requested_execution_path: 'codex-via-ccb',
        },
        run_command: async (spec) => {
          commands.push(spec.argv.join(' '));

          if (spec.argv[0] === 'git' && spec.argv[1] === 'branch') {
            return { exitCode: 0, stdout: 'feature/phase-2-auth\n', stderr: '' };
          }

          if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-parse' && spec.argv[2] === 'HEAD') {
            return { exitCode: 0, stdout: 'abc123def456\n', stderr: '' };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'view') {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                number: 123,
                url: 'https://github.com/LaPaGaYo/project-tracker/pull/123',
                state: 'OPEN',
                headRefName: 'feature/phase-2-auth',
                headRefOid: 'abc123def456',
                baseRefName: 'main',
              }),
              stderr: '',
            };
          }

          throw new Error(`unexpected command: ${spec.argv.join(' ')}`);
        },
      });

      expect(await run.readJson('.planning/current/ship/pull-request.json')).toMatchObject({
        status: 'reused',
        provider: 'github',
        number: 123,
        url: 'https://github.com/LaPaGaYo/project-tracker/pull/123',
        head_branch: 'feature/phase-2-auth',
        head_sha: 'abc123def456',
        base_branch: 'main',
      });
      expect(commands).toEqual([
        'git branch --show-current',
        'git rev-parse HEAD',
        'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      ]);
    });
  });

  test('does not reuse closed or merged pull requests', async () => {
    for (const state of ['CLOSED', 'MERGED'] as const) {
      await runInTempRepo(async ({ cwd, run }) => {
        await run('plan');
        await run('handoff');
        await run('build');
        await run('review');

        const commands: string[] = [];
        let prViewCount = 0;
        const adapters = makeFakeAdapters({
          superpowers: {
            ship_discipline: async () => ({
              adapter_id: 'superpowers',
              outcome: 'success',
              raw_output: {
                release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
                checklist: {
                  review_complete: true,
                  qa_ready: true,
                  merge_ready: true,
                },
                merge_ready: true,
              },
              requested_route: null,
              actual_route: null,
              notices: [],
              conflict_candidates: [],
              traceability: {
                nexus_stage_pack: 'nexus-ship-pack',
                absorbed_capability: 'superpowers-ship-discipline',
                source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
              },
            }),
          },
        });

        const invocation = resolveInvocation('ship');
        await invocation.handler({
          cwd,
          clock: () => new Date().toISOString(),
          via: invocation.via,
          adapters,
          execution: {
            mode: 'governed_ccb',
            primary_provider: 'codex',
            provider_topology: 'multi_session',
            requested_execution_path: 'codex-via-ccb',
          },
          run_command: async (spec) => {
            commands.push(spec.argv.join(' '));

            if (spec.argv[0] === 'git' && spec.argv[1] === 'branch') {
              return { exitCode: 0, stdout: 'feature/phase-2-auth\n', stderr: '' };
            }

            if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-parse' && spec.argv[2] === 'HEAD') {
              return { exitCode: 0, stdout: 'abc123def456\n', stderr: '' };
            }

            if (
              spec.argv[0] === 'git'
              && spec.argv[1] === 'rev-parse'
              && spec.argv[2] === '--abbrev-ref'
            ) {
              return { exitCode: 0, stdout: 'origin/feature/phase-2-auth\n', stderr: '' };
            }

            if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-list') {
              return { exitCode: 0, stdout: '0\t0\n', stderr: '' };
            }

            if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'view') {
              prViewCount += 1;
              if (prViewCount === 1) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({
                    number: 456,
                    url: `https://github.com/LaPaGaYo/project-tracker/pull/456-${state.toLowerCase()}`,
                    state,
                    headRefName: 'feature/phase-2-auth',
                    headRefOid: 'deadbeefcafefeed',
                    baseRefName: 'main',
                  }),
                  stderr: '',
                };
              }

              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  number: 789,
                  url: 'https://github.com/LaPaGaYo/project-tracker/pull/789',
                  state: 'OPEN',
                  headRefName: 'feature/phase-2-auth',
                  headRefOid: 'abc123def456',
                  baseRefName: 'main',
                }),
                stderr: '',
              };
            }

            if (spec.argv[0] === 'gh' && spec.argv[1] === 'repo' && spec.argv[2] === 'view') {
              return { exitCode: 0, stdout: 'main\n', stderr: '' };
            }

            if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'create') {
              return {
                exitCode: 0,
                stdout: 'https://github.com/LaPaGaYo/project-tracker/pull/789\n',
                stderr: '',
              };
            }

            throw new Error(`unexpected command: ${spec.argv.join(' ')}`);
          },
        });

        expect(await run.readJson('.planning/current/ship/pull-request.json')).toMatchObject({
          status: 'created',
        provider: 'github',
        number: 789,
        url: 'https://github.com/LaPaGaYo/project-tracker/pull/789',
        head_branch: 'feature/phase-2-auth',
        head_sha: 'abc123def456',
        base_branch: 'main',
      });
      expect(commands).toEqual([
        'git branch --show-current',
        'git rev-parse HEAD',
        'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
        'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
        'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
        'git rev-list --left-right --count @{u}...HEAD',
        'gh pr create --base main --head feature/phase-2-auth --fill',
        'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      ]);
      });
    }
  });

  test('records unavailable pull request metadata without blocking ship when GitHub CLI handoff cannot run', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      const invocation = resolveInvocation('ship');
      await invocation.handler({
        cwd,
        clock: () => new Date().toISOString(),
        via: invocation.via,
        adapters,
        execution: {
          mode: 'governed_ccb',
          primary_provider: 'codex',
          provider_topology: 'multi_session',
          requested_execution_path: 'codex-via-ccb',
        },
        run_command: async (spec) => {
          if (spec.argv[0] === 'git' && spec.argv[1] === 'branch') {
            return { exitCode: 0, stdout: 'feature/phase-2-auth\n', stderr: '' };
          }

          if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-parse' && spec.argv[2] === 'HEAD') {
            return { exitCode: 0, stdout: 'abc123def456\n', stderr: '' };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'view') {
            return { exitCode: 1, stdout: '', stderr: 'gh: authentication required\n' };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'repo' && spec.argv[2] === 'view') {
            return { exitCode: 1, stdout: '', stderr: 'gh: authentication required\n' };
          }

          throw new Error(`unexpected command: ${spec.argv.join(' ')}`);
        },
      });

      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        stage: 'ship',
        state: 'completed',
        ready: true,
        pull_request: {
          status: 'unavailable',
          provider: 'github',
          head_sha: 'abc123def456',
        },
      });
      expect(await run.readJson('.planning/current/ship/pull-request.json')).toMatchObject({
        status: 'unavailable',
        provider: 'github',
        head_branch: 'feature/phase-2-auth',
        head_sha: 'abc123def456',
      });
      expect(await run.readJson('.planning/current/ship/pull-request.json')).toHaveProperty('reason');
    });
  });

  test('blocks closeout and asks for a push when ship cannot create a PR for an unpushed branch', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const commands: string[] = [];
      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      const invocation = resolveInvocation('ship');
      await invocation.handler({
        cwd,
        clock: () => new Date().toISOString(),
        via: invocation.via,
        adapters,
        execution: {
          mode: 'governed_ccb',
          primary_provider: 'codex',
          provider_topology: 'multi_session',
          requested_execution_path: 'codex-via-ccb',
        },
        run_command: async (spec) => {
          commands.push(spec.argv.join(' '));

          if (spec.argv[0] === 'git' && spec.argv[1] === 'branch') {
            return { exitCode: 0, stdout: 'feature/phase-2-auth\n', stderr: '' };
          }

          if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-parse' && spec.argv[2] === 'HEAD') {
            return { exitCode: 0, stdout: 'abc123def456\n', stderr: '' };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'view') {
            return { exitCode: 1, stdout: '', stderr: 'no pull request found\n' };
          }

          if (spec.argv[0] === 'gh' && spec.argv[1] === 'repo' && spec.argv[2] === 'view') {
            return { exitCode: 0, stdout: 'main\n', stderr: '' };
          }

          if (
            spec.argv[0] === 'git'
            && spec.argv[1] === 'rev-parse'
            && spec.argv[2] === '--abbrev-ref'
          ) {
            return { exitCode: 128, stdout: '', stderr: 'fatal: no upstream configured\n' };
          }

          if (spec.argv[0] === 'git' && spec.argv[1] === 'remote') {
            return { exitCode: 0, stdout: 'origin\n', stderr: '' };
          }

          throw new Error(`unexpected command: ${spec.argv.join(' ')}`);
        },
      });

      expect(await run.readJson('.planning/current/ship/pull-request.json')).toMatchObject({
        status: 'push_required',
        provider: 'github',
        head_branch: 'feature/phase-2-auth',
        head_sha: 'abc123def456',
        base_branch: 'main',
        push_command: 'git push -u origin HEAD',
      });
      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        stage: 'ship',
        state: 'completed',
        decision: 'ship_recorded',
        ready: false,
        errors: ['Current branch has no upstream; push it before creating the PR.'],
      });
      expect(await run.readJson('.planning/current/ship/completion-advisor.json')).toMatchObject({
        interaction_mode: 'required_choice',
        default_action_id: 'push_branch',
        primary_next_actions: [
          expect.objectContaining({
            id: 'push_branch',
            kind: 'manual_command',
            invocation: 'git push -u origin HEAD',
          }),
          expect.objectContaining({
            id: 'rerun_ship_after_push',
            surface: '/ship',
          }),
        ],
      });
      expect(commands).toEqual([
        'git branch --show-current',
        'git rev-parse HEAD',
        'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
        'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
        'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
        'git remote',
      ]);
      await expect(run('closeout')).rejects.toThrow('Ship must be ready before closeout');
    });
  });

  test('writes release gate artifacts when merge is ready', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const calls: string[] = [];
      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => {
            calls.push('ship');
            return {
              adapter_id: 'superpowers',
              outcome: 'success',
              raw_output: {
                release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
                checklist: {
                  review_complete: true,
                  qa_ready: true,
                  merge_ready: true,
                },
                merge_ready: true,
              },
              requested_route: null,
              actual_route: null,
              notices: [],
              conflict_candidates: [],
              traceability: {
                nexus_stage_pack: 'nexus-ship-pack',
                absorbed_capability: 'superpowers-ship-discipline',
                source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
              },
            };
          },
        },
      });

      await run('ship', adapters);

      expect(calls).toEqual(['ship']);
      expect(await run.readFile('.planning/current/ship/release-gate-record.md')).toContain('merge ready');
      expect(await run.readJson('.planning/current/ship/checklist.json')).toMatchObject({
        review_complete: true,
        qa_ready: true,
        merge_ready: true,
        design_impact: 'none',
        design_contract_path: null,
        design_verified: null,
      });
      expect(await run.readFile('.planning/current/ship/release-gate-record.md')).toContain(
        'Design verification',
      );
      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        stage: 'ship',
        state: 'completed',
        decision: 'ship_recorded',
        ready: true,
      });
      expect(await run.readJson('.planning/current/ship/adapter-output.json')).toMatchObject({
        adapter_id: 'superpowers',
        outcome: 'success',
        traceability: {
          nexus_stage_pack: 'nexus-ship-pack',
          absorbed_capability: 'superpowers-ship-discipline',
        },
      });
    });
  });

  test('writes ship learning candidates when valid candidates exist', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const candidatesPath = shipLearningCandidatesPath();
      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
              learning_candidates: [
                {
                  type: 'pattern',
                  key: 'ship-learning-capture',
                  insight: 'Ship should persist only valid reusable candidates.',
                  confidence: 8,
                  source: 'observed',
                  files: ['lib/nexus/commands/ship.ts', ''],
                },
                {
                  type: 'pattern',
                  key: '',
                  insight: 'This invalid candidate must be ignored.',
                  confidence: 5,
                  source: 'observed',
                  files: ['lib/nexus/commands/ship.ts'],
                },
              ],
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      await run('ship', adapters);

      expect(existsSync(join(cwd, candidatesPath))).toBe(true);
      expect(await run.readJson('.planning/current/ship/learning-candidates.json')).toMatchObject({
        schema_version: 1,
        run_id: expect.any(String),
        stage: 'ship',
        candidates: [
          {
            type: 'pattern',
            key: 'ship-learning-capture',
            insight: 'Ship should persist only valid reusable candidates.',
            confidence: 8,
            source: 'observed',
            files: ['lib/nexus/commands/ship.ts'],
          },
        ],
      });
      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        learning_candidates_path: candidatesPath,
        learnings_recorded: true,
        outputs: expect.arrayContaining([
          expect.objectContaining({ path: candidatesPath, kind: 'json' }),
        ]),
      });
      expect(await run.readJson('.planning/nexus/current-run.json')).toMatchObject({
        artifact_index: {
          [candidatesPath]: expect.objectContaining({ path: candidatesPath, kind: 'json' }),
        },
      });
    });
  });

  test('does not write ship learning candidates when there are none', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const candidatesPath = shipLearningCandidatesPath();
      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
              learning_candidates: [],
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      await run('ship', adapters);

      expect(existsSync(join(cwd, candidatesPath))).toBe(false);
      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        learning_candidates_path: null,
        learnings_recorded: false,
      });
      expect(await run.readJson('.planning/current/ship/status.json').then((status) => status.outputs)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '.planning/current/ship/release-gate-record.md' }),
          expect.objectContaining({ path: '.planning/current/ship/checklist.json' }),
          expect.objectContaining({ path: '.planning/current/ship/pull-request.json' }),
          expect.objectContaining({ path: '.planning/current/ship/status.json' }),
        ]),
      );
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      expect(ledger.artifact_index[candidatesPath]).toBeUndefined();
    });
  });

  test('clears stale ship learning candidates on a later success with none', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const candidatesPath = shipLearningCandidatesPath();
      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      ledger.artifact_index[candidatesPath] = { kind: 'json', path: candidatesPath };
      ledger.current_command = 'review';
      ledger.current_stage = 'review';
      ledger.previous_stage = 'build';
      ledger.allowed_next_stages = ['ship'];
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
      mkdirSync(join(cwd, '.planning/current/ship'), { recursive: true });
      writeFileSync(join(cwd, candidatesPath), JSON.stringify({ stale: true }, null, 2) + '\n');

      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      await run('ship', adapters);

      expect(existsSync(join(cwd, candidatesPath))).toBe(false);
      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        learning_candidates_path: null,
        learnings_recorded: false,
      });
      const updatedLedger = await run.readJson('.planning/nexus/current-run.json');
      expect(updatedLedger.artifact_index[candidatesPath]).toBeUndefined();
    });
  });

  test('clears stale ship learning candidates on refused ship', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const candidatesPath = shipLearningCandidatesPath();
      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      ledger.artifact_index[candidatesPath] = { kind: 'json', path: candidatesPath };
      ledger.current_command = 'review';
      ledger.current_stage = 'review';
      ledger.previous_stage = 'build';
      ledger.allowed_next_stages = ['ship'];
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
      mkdirSync(join(cwd, '.planning/current/ship'), { recursive: true });
      writeFileSync(join(cwd, candidatesPath), JSON.stringify({ stale: true }, null, 2) + '\n');

      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'refused',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: merge ready\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: true,
              },
              merge_ready: true,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      await expect(run('ship', adapters)).rejects.toThrow('Superpowers ship discipline refused ship');
      expect(existsSync(join(cwd, candidatesPath))).toBe(false);
      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        state: 'refused',
        learning_candidates_path: null,
        learnings_recorded: false,
      });
      const updatedLedger = await run.readJson('.planning/nexus/current-run.json');
      expect(updatedLedger.artifact_index[candidatesPath]).toBeUndefined();
    });
  });

  test('clears stale ship learning candidates on blocked ship', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const candidatesPath = shipLearningCandidatesPath();
      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      ledger.artifact_index[candidatesPath] = { kind: 'json', path: candidatesPath };
      ledger.current_command = 'review';
      ledger.current_stage = 'review';
      ledger.previous_stage = 'build';
      ledger.allowed_next_stages = ['ship'];
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
      mkdirSync(join(cwd, '.planning/current/ship'), { recursive: true });
      writeFileSync(join(cwd, candidatesPath), JSON.stringify({ stale: true }, null, 2) + '\n');

      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'blocked',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: blocked\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: false,
              },
              merge_ready: false,
            },
            requested_route: null,
            actual_route: null,
            notices: ['Ship discipline blocked'],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      await expect(run('ship', adapters)).rejects.toThrow('Superpowers ship discipline blocked ship');
      expect(existsSync(join(cwd, candidatesPath))).toBe(false);
      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        state: 'blocked',
        learning_candidates_path: null,
        learnings_recorded: false,
      });
      const updatedLedger = await run.readJson('.planning/nexus/current-run.json');
      expect(updatedLedger.artifact_index[candidatesPath]).toBeUndefined();
    });
  });

  test('default ship gate record carries Nexus-owned absorbed ship guidance', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');
      await run('ship');

      expect(await run.readFile('.planning/current/ship/release-gate-record.md')).toContain(
        'Nexus-owned ship guidance for governed release gating and explicit merge readiness.',
      );
      expect(await run.readFile('.planning/current/ship/release-gate-record.md')).toContain(
        'require completed review artifacts',
      );
      expect(await run.readFile('.planning/current/ship/release-gate-record.md')).toContain(
        'Ship content starts only after completed review and optional ready QA.',
      );
    });
  });

  test('blocks ship without completed review', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');

      await expect(run('ship')).rejects.toThrow('Review must be completed before ship');
    });
  });

  test('blocks ship when QA exists and is not ready', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const qaAdapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: fail\n\n- Checkout flow is broken\n',
              ready: false,
              findings: ['Checkout flow is broken'],
              receipt: 'qa-fail',
            },
            requested_route: ctx.requested_route,
            actual_route: {
              provider: 'gemini',
              route: ctx.requested_route?.generator ?? 'gemini-via-ccb',
              substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
              transport: 'ccb',
              receipt_path: '.planning/current/qa/adapter-output.json',
            },
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-qa-pack',
              absorbed_capability: 'ccb-qa',
              source_map: ['vendor/upstream/claude-code-bridge/lib/gemini_comm.py'],
            },
          }),
        },
      });

      await run('qa', qaAdapters);
      await expect(run('ship')).rejects.toThrow('QA must be ready before ship');
    });
  });

  test('records a conservative blocked release gate when merge is not ready', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const adapters = makeFakeAdapters({
        superpowers: {
          ship_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              release_gate_record: '# Release Gate Record\n\nResult: blocked\n',
              checklist: {
                review_complete: true,
                qa_ready: true,
                merge_ready: false,
              },
              merge_ready: false,
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
            traceability: {
              nexus_stage_pack: 'nexus-ship-pack',
              absorbed_capability: 'superpowers-ship-discipline',
              source_map: ['vendor/upstream/superpowers/skills/finishing-a-development-branch/SKILL.md'],
            },
          }),
        },
      });

      await run('ship', adapters);

      expect(await run.readJson('.planning/current/ship/status.json')).toMatchObject({
        stage: 'ship',
        state: 'completed',
        decision: 'ship_recorded',
        ready: false,
      });
      expect(await run.readFile('.planning/current/ship/release-gate-record.md')).toContain('blocked');
      expect(await run.readJson('.planning/current/ship/checklist.json')).toMatchObject({
        merge_ready: false,
      });
    });
  });

  test('blocks ship when the run ledger is noncanonical', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      ledger.command_history[ledger.command_history.length - 1] = {
        ...ledger.command_history[ledger.command_history.length - 1],
        gate_decision: 'pass',
      };
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

      await expect(run('ship')).rejects.toThrow('Run ledger is not canonical before ship');
    });
  });

  test('blocks ship when governed tail-stage ledger is missing run-level route check', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      delete ledger.route_check;
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

      await expect(run('ship')).rejects.toThrow('Run ledger is not canonical before ship');
    });
  });

  test('does not trust malformed GitHub PR payloads after create', async () => {
    const commands: string[] = [];
    let prViewCount = 0;
    const runCommand: NexusCommandRunner = async (spec) => {
      commands.push(spec.argv.join(' '));

      if (spec.argv[0] === 'git' && spec.argv[1] === 'branch') {
        return { exitCode: 0, stdout: 'feature/phase-3\n', stderr: '' };
      }
      if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-parse' && spec.argv[2] === 'HEAD') {
        return { exitCode: 0, stdout: 'abc123def456\n', stderr: '' };
      }
      if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'view') {
        prViewCount += 1;
        return {
          exitCode: 0,
          stdout: prViewCount === 1
            ? '{"state":"CLOSED"}'
            : '{"number":"not-a-number","url":"https://github.com/example/repo/pull/9","state":"OPEN"}',
          stderr: '',
        };
      }
      if (spec.argv[0] === 'gh' && spec.argv[1] === 'repo') {
        return { exitCode: 0, stdout: 'main\n', stderr: '' };
      }
      if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-parse' && spec.argv.includes('@{u}')) {
        return { exitCode: 0, stdout: 'origin/feature/phase-3\n', stderr: '' };
      }
      if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-list') {
        return { exitCode: 0, stdout: '0\t0\n', stderr: '' };
      }
      if (spec.argv[0] === 'gh' && spec.argv[1] === 'pr' && spec.argv[2] === 'create') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 1, stdout: '', stderr: `unexpected command: ${spec.argv.join(' ')}` };
    };

    const pullRequest = await resolveShipPullRequest('/tmp/repo', true, runCommand);

    expect(pullRequest).toMatchObject({
      status: 'unavailable',
      provider: 'github',
      head_branch: 'feature/phase-3',
      head_sha: 'abc123def456',
      base_branch: 'main',
      reason: 'gh pr view returned invalid JSON',
    });
    expect(commands).toEqual([
      'git branch --show-current',
      'git rev-parse HEAD',
      'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
      'git rev-list --left-right --count @{u}...HEAD',
      'gh pr create --base main --head feature/phase-3 --fill',
      'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
    ]);
  });
});
