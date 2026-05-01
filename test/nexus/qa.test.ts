import { writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { qaLearningCandidatesPath, reviewAdvisoryDispositionPath } from '../../lib/nexus/artifacts';
import { makeFakeAdapters } from './helpers/fake-adapters';
import { runInTempRepo } from './helpers/temp-repo';

describe('nexus qa', () => {
  test('writes design verification for touchup runs', async () => {
    await runInTempRepo(async ({ run }) => {
      const seen: string[][] = [];
      const frameAdapters = makeFakeAdapters({
        pm: {
          frame: async () => ({
            adapter_id: 'pm',
            outcome: 'success',
            raw_output: {
              decision_brief_markdown: '# Decision Brief\n\nScope: touchup UI work\n',
              prd_markdown: '# PRD\n\nSuccess criteria: touchup UI work\n',
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
      });

      const qaAdapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => {
            seen.push(ctx.predecessor_artifacts.map((artifact) => artifact.path));
            return {
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
            };
          },
        },
      });

      await run('discover');
      await run('frame', frameAdapters);
      await run('plan', frameAdapters);
      await run('handoff');
      await run('build');
      await run('review');
      await run('qa', qaAdapters);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(expect.arrayContaining([
        '.planning/current/review/status.json',
        '.planning/current/plan/verification-matrix.json',
      ]));
      expect(await run.readFile('.planning/current/qa/design-verification.md')).toContain('Design impact: touchup');
      expect(await run.readFile('.planning/current/qa/design-verification.md')).toContain('Result: verified');
      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        stage: 'qa',
        state: 'completed',
        decision: 'qa_recorded',
        ready: true,
        design_impact: 'touchup',
        design_contract_path: null,
        design_verified: true,
      });
    });
  });

  test('preserves design verification when the verification matrix still requires it', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      const frameAdapters = makeFakeAdapters({
        pm: {
          frame: async () => ({
            adapter_id: 'pm',
            outcome: 'success',
            raw_output: {
              decision_brief_markdown: '# Decision Brief\n\nScope: material UI work\n',
              prd_markdown: '# PRD\n\nSuccess criteria: material UI work\n',
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
      });

      await run('discover');
      await run('frame', frameAdapters);
      await run('plan', frameAdapters);
      await run('handoff');
      await run('build');
      await run('review');
      await run('qa', qaAdapters);

      expect(await run.readFile('.planning/current/qa/design-verification.md')).toContain('Design impact: material');

      const reviewStatusPath = join(cwd, '.planning/current/review/status.json');
      const reviewStatus = await run.readJson('.planning/current/review/status.json');
      reviewStatus.design_impact = 'none';
      reviewStatus.design_contract_path = null;
      reviewStatus.design_verified = null;
      writeFileSync(reviewStatusPath, JSON.stringify(reviewStatus, null, 2) + '\n');

      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      ledger.current_command = 'review';
      ledger.current_stage = 'review';
      ledger.previous_stage = 'build';
      ledger.allowed_next_stages = ['qa'];
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

      await run('qa', qaAdapters);

      expect(await run.readFile('.planning/current/qa/design-verification.md')).toContain('Result: verified');
      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        design_impact: 'none',
        design_contract_path: null,
        design_verified: true,
      });
      const updatedLedger = await run.readJson('.planning/nexus/current-run.json');
      expect(updatedLedger.artifact_index['.planning/current/qa/design-verification.md']).toMatchObject({
        path: '.planning/current/qa/design-verification.md',
      });
    });
  });

  test('writes qa report and explicit provider route when validation passes', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const calls: string[] = [];
      const adapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => {
            calls.push('qa');
            return {
              adapter_id: 'ccb',
              outcome: 'success',
              raw_output: {
                report_markdown: '# QA Report\n\nResult: pass\n',
                ready: true,
                findings: ['Homepage loads with HTTP 200'],
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
            };
          },
        },
      });

      await run('qa', adapters);

      expect(calls).toEqual(['qa']);
      expect(await run.readFile('.planning/current/qa/qa-report.md')).toContain('Result: pass');
      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        stage: 'qa',
        state: 'completed',
        decision: 'qa_recorded',
        ready: true,
        verification_count: 1,
        defect_count: 0,
        requested_route: {
          command: 'qa',
          generator: 'gemini-via-ccb',
          substrate: 'superpowers-core',
        },
        actual_route: {
          provider: 'gemini',
          route: 'gemini-via-ccb',
          substrate: 'superpowers-core',
          transport: 'ccb',
        },
      });
      expect(await run.readJson('.planning/current/qa/adapter-output.json')).toMatchObject({
        adapter_id: 'ccb',
        outcome: 'success',
        traceability: {
          nexus_stage_pack: 'nexus-qa-pack',
          absorbed_capability: 'ccb-qa',
        },
      });
    });
  });

  test('writes qa learning candidates when valid candidates exist', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const learningCandidatesPath = qaLearningCandidatesPath();
      const adapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: pass\n',
              ready: true,
              findings: [],
              learning_candidates: [
                {
                  type: 'pattern',
                  key: ' qa-learning-path ',
                  insight: ' keep the QA retry path lean ',
                  confidence: 0.91,
                  source: 'observed',
                  files: [' src/qa/path.ts ', '   '],
                },
                {
                  type: 'pattern',
                  key: ' ',
                  insight: '',
                  confidence: 0.5,
                  source: 'observed',
                  files: ['src/qa/ignored.ts'],
                },
              ] as any,
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
      });

      await run('qa', adapters);

      expect(run.exists(learningCandidatesPath)).toBe(true);
      expect(await run.readJson(learningCandidatesPath)).toMatchObject({
        schema_version: 1,
        stage: 'qa',
        candidates: [
          {
            type: 'pattern',
            key: 'qa-learning-path',
            insight: 'keep the QA retry path lean',
            confidence: 0.91,
            source: 'observed',
            files: ['src/qa/path.ts'],
          },
        ],
      });
      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        learning_candidates_path: learningCandidatesPath,
        learnings_recorded: true,
      });
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      expect(ledger.artifact_index[learningCandidatesPath]).toMatchObject({
        kind: 'json',
        path: learningCandidatesPath,
      });
    });
  });

  test('does not write qa learning candidates when none are valid', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const learningCandidatesPath = qaLearningCandidatesPath();
      const adapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: pass\n',
              ready: true,
              findings: [],
              learning_candidates: [],
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
      });

      await run('qa', adapters);

      expect(run.exists(learningCandidatesPath)).toBe(false);
      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        learning_candidates_path: null,
        learnings_recorded: false,
      });
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      expect(ledger.artifact_index[learningCandidatesPath]).toBeUndefined();
    });
  });

  test('clears stale qa learning candidates when a later success has none', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const learningCandidatesPath = qaLearningCandidatesPath();
      const withCandidatesAdapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: pass\n',
              ready: true,
              findings: [],
              learning_candidates: [
                {
                  type: 'tool',
                  key: 'qa-trace',
                  insight: 'Record the QA trace artifact when candidates exist.',
                  confidence: 0.84,
                  source: 'observed',
                  files: ['src/nexus/commands/qa.ts'],
                },
              ],
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
      });

      await run('qa', withCandidatesAdapters);
      expect(run.exists(learningCandidatesPath)).toBe(true);

      const reviewStatusPath = join(cwd, '.planning/current/review/status.json');
      const reviewStatus = await run.readJson('.planning/current/review/status.json');
      reviewStatus.design_impact = 'none';
      reviewStatus.design_contract_path = null;
      reviewStatus.design_verified = null;
      writeFileSync(reviewStatusPath, JSON.stringify(reviewStatus, null, 2) + '\n');

      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      ledger.current_command = 'review';
      ledger.current_stage = 'review';
      ledger.previous_stage = 'build';
      ledger.allowed_next_stages = ['qa'];
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

      const noCandidatesAdapters = makeFakeAdapters({
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
      });

      await run('qa', noCandidatesAdapters);

      expect(run.exists(learningCandidatesPath)).toBe(false);
      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        learning_candidates_path: null,
        learnings_recorded: false,
      });
      const updatedLedger = await run.readJson('.planning/nexus/current-run.json');
      expect(updatedLedger.artifact_index[learningCandidatesPath]).toBeUndefined();
    });
  });

  test('clears stale qa learning candidates when a later blocked QA route mismatches', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const learningCandidatesPath = qaLearningCandidatesPath();
      const withCandidatesAdapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: pass\n',
              ready: true,
              findings: [],
              learning_candidates: [
                {
                  type: 'tool',
                  key: 'qa-route-trace',
                  insight: 'Record the requested QA route before writeback.',
                  confidence: 0.84,
                  source: 'observed',
                  files: ['lib/nexus/commands/qa.ts'],
                },
              ],
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
      });

      await run('qa', withCandidatesAdapters);
      expect(run.exists(learningCandidatesPath)).toBe(true);

      const reviewStatusPath = join(cwd, '.planning/current/review/status.json');
      const reviewStatus = await run.readJson('.planning/current/review/status.json');
      reviewStatus.design_impact = 'none';
      reviewStatus.design_contract_path = null;
      reviewStatus.design_verified = null;
      writeFileSync(reviewStatusPath, JSON.stringify(reviewStatus, null, 2) + '\n');

      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      ledger.current_command = 'review';
      ledger.current_stage = 'review';
      ledger.previous_stage = 'build';
      ledger.allowed_next_stages = ['qa'];
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

      const routeMismatchAdapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: pass\n',
              ready: true,
              findings: [],
              learning_candidates: [
                {
                  type: 'pitfall',
                  key: 'should-not-write-on-mismatch',
                  insight: 'Route mismatches must block before canonical learning writes.',
                  confidence: 0.8,
                  source: 'observed',
                  files: ['lib/nexus/commands/qa.ts'],
                },
              ],
              receipt: 'qa-pass',
            },
            requested_route: ctx.requested_route,
            actual_route: {
              provider: 'codex',
              route: 'codex-via-ccb',
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

      await expect(run('qa', routeMismatchAdapters)).rejects.toThrow('Requested and actual QA route diverged');

      expect(run.exists(learningCandidatesPath)).toBe(false);
      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        stage: 'qa',
        state: 'blocked',
        learning_candidates_path: null,
        learnings_recorded: false,
      });
      const updatedLedger = await run.readJson('.planning/nexus/current-run.json');
      expect(updatedLedger.artifact_index[learningCandidatesPath]).toBeUndefined();
    });
  });

  test('default qa report carries Nexus-owned absorbed qa guidance', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');
      await run('qa');

      expect(await run.readFile('.planning/current/qa/qa-report.md')).toContain(
        'Nexus-owned QA guidance for governed validation scope beyond code review.',
      );
      expect(await run.readFile('.planning/current/qa/qa-report.md')).toContain(
        'define governed validation scope after completed review',
      );
      expect(await run.readFile('.planning/current/qa/qa-report.md')).toContain(
        'QA content starts only after completed review.',
      );
    });
  });

  test('records qa as not ready when validation finds defects', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const adapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: fail\n\n- Login form is broken\n',
              ready: false,
              findings: ['Login form is broken'],
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

      await run('qa', adapters);

      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        stage: 'qa',
        state: 'completed',
        decision: 'qa_recorded',
        ready: false,
        review_scope: {
          mode: 'bounded_fix_cycle',
          source_stage: 'qa',
          blocking_items: ['Login form is broken'],
          advisory_policy: 'out_of_scope_advisory',
        },
        verification_count: 0,
        defect_count: 1,
      });
      expect(await run.readJson('.planning/nexus/current-run.json')).toMatchObject({
        status: 'blocked',
        current_stage: 'qa',
        allowed_next_stages: ['build'],
      });
      expect(await run.readFile('.planning/current/qa/qa-report.md')).toContain('Login form is broken');
    });
  });

  test('allows blocked qa to retry qa directly without a build fix cycle', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const blockedAdapters = makeFakeAdapters({
        ccb: {
          execute_qa: async () => ({
            adapter_id: 'ccb',
            outcome: 'blocked',
            raw_output: {
              report_markdown: '',
              ready: false,
              findings: [],
              receipt: '',
            },
            requested_route: null,
            actual_route: null,
            notices: ['QA validation transport failed before producing a report'],
            conflict_candidates: [],
          }),
        },
      });

      await expect(run('qa', blockedAdapters)).rejects.toThrow('CCB QA validation blocked');
      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        state: 'blocked',
        ready: false,
      });
      expect(await run.readJson('.planning/nexus/current-run.json')).toMatchObject({
        status: 'blocked',
        current_stage: 'qa',
        allowed_next_stages: ['qa'],
      });

      const passAdapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: pass\n',
              ready: true,
              findings: [],
              receipt: 'qa-pass-after-retry',
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

      await run('qa', passAdapters);

      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        state: 'completed',
        ready: true,
        defect_count: 0,
      });
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      expect(ledger).toMatchObject({
        status: 'active',
        previous_stage: 'qa',
        current_stage: 'qa',
        allowed_next_stages: ['ship', 'closeout'],
      });
      expect(ledger.command_history.map((entry: { command: string }) => entry.command).slice(-2)).toEqual(['qa', 'qa']);
    });
  });

  test('requires build fix cycle before rerunning completed failed qa', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const failAdapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: fail\n\n- Login form is broken\n',
              ready: false,
              findings: ['Login form is broken'],
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

      await run('qa', failAdapters);

      await expect(run('qa')).rejects.toThrow('QA found defects; run /build fix cycle before rerunning QA');
    });
  });

  test('blocks qa when review advisories require an explicit disposition', async () => {
    await runInTempRepo(async ({ run }) => {
      const reviewAdapters = makeFakeAdapters({
        superpowers: {
          review_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              discipline_summary: 'Verification-before-completion passed',
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
          }),
        },
        ccb: {
          execute_audit_a: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              markdown: '# Codex Audit\n\nResult: pass\n\nFindings:\n- none\n\nAdvisories:\n- Identifier column should be clickable.\n',
              receipt: 'codex-review-receipt',
            },
            requested_route: ctx.requested_route,
            actual_route: {
              provider: 'codex',
              route: ctx.requested_route?.evaluator_a ?? 'codex-via-ccb',
              substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
              transport: 'ccb',
              receipt_path: '.planning/current/review/adapter-output.json',
            },
            notices: [],
            conflict_candidates: [],
          }),
          execute_audit_b: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              markdown: '# Gemini Audit\n\nResult: pass\n\nFindings:\n- none\n\nAdvisories:\n- Build warning about multiple lockfiles.\n',
              receipt: 'gemini-review-receipt',
            },
            requested_route: ctx.requested_route,
            actual_route: {
              provider: 'gemini',
              route: ctx.requested_route?.evaluator_b ?? 'gemini-via-ccb',
              substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
              transport: 'ccb',
              receipt_path: '.planning/current/review/adapter-output.json',
            },
            notices: [],
            conflict_candidates: [],
          }),
        },
      });

      await run('plan');
      await run('handoff');
      await run('build');
      await run('review', reviewAdapters);

      await expect(run('qa')).rejects.toThrow(/Review advisories require an explicit disposition before qa/i);
    });
  });

  test('records advisories without blocking QA readiness', async () => {
    await runInTempRepo(async ({ run }) => {
      const reviewAdapters = makeFakeAdapters({
        superpowers: {
          review_discipline: async () => ({
            adapter_id: 'superpowers',
            outcome: 'success',
            raw_output: {
              discipline_summary: 'Verification-before-completion passed',
            },
            requested_route: null,
            actual_route: null,
            notices: [],
            conflict_candidates: [],
          }),
        },
        ccb: {
          execute_audit_a: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              markdown: '# Codex Audit\n\nResult: pass\n\nFindings:\n- none\n\nAdvisories:\n- WorkspaceError is duplicated across module boundaries.\n',
              receipt: 'codex-review-receipt',
            },
            requested_route: ctx.requested_route,
            actual_route: {
              provider: 'codex',
              route: ctx.requested_route?.evaluator_a ?? 'codex-via-ccb',
              substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
              transport: 'ccb',
              receipt_path: '.planning/current/review/adapter-output.json',
            },
            notices: [],
            conflict_candidates: [],
          }),
          execute_audit_b: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              markdown: '# Gemini Audit\n\nResult: pass\n\nFindings:\n- none\n\nAdvisories:\n- none\n',
              receipt: 'gemini-review-receipt',
            },
            requested_route: ctx.requested_route,
            actual_route: {
              provider: 'gemini',
              route: ctx.requested_route?.evaluator_b ?? 'gemini-via-ccb',
              substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
              transport: 'ccb',
              receipt_path: '.planning/current/review/adapter-output.json',
            },
            notices: [],
            conflict_candidates: [],
          }),
        },
      });

      await run('plan');
      await run('handoff');
      await run('build');
      await run('review', reviewAdapters);

      const adapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: [
                '# QA Report',
                '',
                'Result: pass',
                '',
                'Findings:',
                '- none',
                '',
                'Advisories:',
                '- WorkspaceError is duplicated across module boundaries.',
              ].join('\n'),
              ready: true,
              findings: [],
              advisories: ['WorkspaceError is duplicated across module boundaries.'],
              receipt: 'qa-advisory',
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

      await run('qa', adapters, undefined, { reviewAdvisoryDispositionOverride: 'continue_to_qa' });

      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        stage: 'qa',
        state: 'completed',
        decision: 'qa_recorded',
        ready: true,
        errors: [],
        advisory_count: 1,
        defect_count: 0,
      });
      expect(await run.readJson('.planning/nexus/current-run.json')).toMatchObject({
        status: 'active',
        current_stage: 'qa',
        allowed_next_stages: ['ship', 'closeout'],
      });
      expect(await run.readJson(reviewAdvisoryDispositionPath())).toMatchObject({
        selected: 'continue_to_qa',
      });
      expect(await run.readFile('.planning/current/qa/qa-report.md')).toContain('Advisories:');
      expect(await run.readFile('.planning/current/qa/qa-report.md')).toContain('WorkspaceError is duplicated across module boundaries.');
    });
  });

  test('blocks qa when requested and actual validation route diverge', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const learningCandidatesPath = qaLearningCandidatesPath();

      const adapters = makeFakeAdapters({
        ccb: {
          execute_qa: async (ctx) => ({
            adapter_id: 'ccb',
            outcome: 'success',
            raw_output: {
              report_markdown: '# QA Report\n\nResult: pass\n',
              ready: true,
              findings: [],
              learning_candidates: [
                {
                  type: 'pitfall',
                  key: 'qa-route-mismatch',
                  insight: 'QA route mismatches should block before canonical writeback.',
                  confidence: 0.82,
                  source: 'observed',
                  files: ['lib/nexus/commands/qa.ts'],
                },
              ],
              receipt: 'qa-pass',
            },
            requested_route: ctx.requested_route,
            actual_route: {
              provider: 'codex',
              route: 'codex-via-ccb',
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

      await expect(run('qa', adapters)).rejects.toThrow('Requested and actual QA route diverged');

      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        stage: 'qa',
        state: 'blocked',
        ready: false,
      });
      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        learning_candidates_path: null,
        learnings_recorded: false,
      });
      await expect(run.readFile(learningCandidatesPath)).rejects.toThrow();
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      expect(ledger.artifact_index[learningCandidatesPath]).toBeUndefined();
      expect(await run.readJson('.planning/current/conflicts/qa-ccb.json')).toMatchObject({
        stage: 'qa',
        adapter: 'ccb',
        kind: 'route_mismatch',
        message: 'Requested and actual QA route diverged',
      });
    });
  });

  test('surfaces human-readable latency diagnostics when a CCB QA execution blocks', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const adapters = makeFakeAdapters({
        ccb: {
          execute_qa: async () => ({
            adapter_id: 'ccb',
            outcome: 'blocked',
            raw_output: {
              report_markdown: '',
              ready: false,
              findings: [],
              receipt: '',
              latency_summary: {
                path: 'watchdog_recovery',
                likely_cause: 'orchestration_false_start',
                foreground_exit: 'nonzero',
                foreground_retry_count: 0,
                finalize_nudge_issued: true,
                pend_attempts: 1,
                recovered_via: null,
              },
            },
            requested_route: null,
            actual_route: null,
            notices: ['QA provider exited early'],
            conflict_candidates: [],
          }),
        },
      });

      await expect(run('qa', adapters)).rejects.toThrow('CCB QA validation blocked');

      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        state: 'blocked',
        errors: [
          expect.stringContaining('cause=foreground false-start'),
        ],
      });
      expect(await run.readJson('.planning/current/qa/adapter-output.json')).toMatchObject({
        latency_diagnostic: expect.stringContaining('cause=foreground false-start'),
      });
    });
  });

  test('does not write qa learning candidates when validation is refused', async () => {
    await runInTempRepo(async ({ run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const learningCandidatesPath = qaLearningCandidatesPath();
      const adapters = makeFakeAdapters({
        ccb: {
          execute_qa: async () => ({
            adapter_id: 'ccb',
            outcome: 'refused',
            raw_output: {
              report_markdown: '',
              ready: false,
              findings: [],
              receipt: '',
            },
            requested_route: null,
            actual_route: null,
            notices: ['QA validation refused'],
            conflict_candidates: [],
          }),
        },
      });

      await expect(run('qa', adapters)).rejects.toThrow('CCB QA validation refused');

      expect(await run.readJson('.planning/current/qa/status.json')).toMatchObject({
        stage: 'qa',
        state: 'refused',
        ready: false,
        learning_candidates_path: null,
        learnings_recorded: false,
      });
      await expect(run.readFile(learningCandidatesPath)).rejects.toThrow();
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      expect(ledger.artifact_index[learningCandidatesPath]).toBeUndefined();
    });
  });

  test('blocks qa when the run ledger is noncanonical', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = await run.readJson('.planning/nexus/current-run.json');
      ledger.command_history[ledger.command_history.length - 1] = {
        ...ledger.command_history[ledger.command_history.length - 1],
        gate_decision: 'fail',
      };
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

      await expect(run('qa')).rejects.toThrow('Run ledger is not canonical before QA');
    });
  });
});
