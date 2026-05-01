import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  closeoutDocumentationSyncPath,
  closeoutFollowOnSummaryJsonPath,
  closeoutFollowOnSummaryMarkdownPath,
  closeoutNextRunBootstrapJsonPath,
  qaPerfVerificationPath,
  shipCanaryStatusPath,
  shipDeployResultPath,
  stageStatusPath,
} from '../../lib/nexus/artifacts';
import { refreshCurrentCloseoutFollowOnArtifacts } from '../../lib/nexus/closeout-follow-on-refresh';
import type { ExecutionSelection } from '../../lib/nexus/execution-topology';
import { startLedger, writeLedger } from '../../lib/nexus/ledger';
import { writeStageStatus } from '../../lib/nexus/status';
import type { CanonicalCommandId, StageDecision, StageStatus } from '../../lib/nexus/types';

const CLOSEOUT_RECORD_PATH = '.planning/current/closeout/CLOSEOUT-RECORD.md';
const TEST_EXECUTION: ExecutionSelection = {
  mode: 'local_provider',
  primary_provider: 'codex',
  provider_topology: 'single_agent',
  requested_execution_path: '.',
};

function withTempRepo(fn: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'nexus-follow-on-refresh-'));
  try {
    fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function writeRepoFile(cwd: string, path: string, content: string): void {
  const absolutePath = join(cwd, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function writeRepoJson(cwd: string, path: string, value: unknown): void {
  writeRepoFile(cwd, path, JSON.stringify(value, null, 2) + '\n');
}

function readRepoFile(cwd: string, path: string): string {
  return readFileSync(join(cwd, path), 'utf8');
}

function readRepoJson<T>(cwd: string, path: string): T {
  return JSON.parse(readRepoFile(cwd, path)) as T;
}

function decisionFor(stage: CanonicalCommandId): StageDecision {
  if (stage === 'review') {
    return 'audit_recorded';
  }
  if (stage === 'qa') {
    return 'qa_recorded';
  }
  if (stage === 'ship') {
    return 'ship_recorded';
  }
  if (stage === 'closeout') {
    return 'closeout_recorded';
  }
  return 'ready';
}

function completedStatus(runId: string, stage: CanonicalCommandId, overrides: Partial<StageStatus> = {}): StageStatus {
  return {
    run_id: runId,
    stage,
    state: 'completed',
    decision: decisionFor(stage),
    ready: true,
    inputs: [],
    outputs: [],
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:01:00.000Z',
    errors: [],
    ...overrides,
  };
}

function seedCloseout(cwd: string): string {
  const runId = 'run-follow-on-refresh';
  writeLedger({
    ...startLedger(runId, 'closeout', TEST_EXECUTION),
    status: 'completed',
    current_command: 'closeout',
    current_stage: 'closeout',
    previous_stage: 'ship',
    allowed_next_stages: [],
  }, cwd);
  writeStageStatus(stageStatusPath('review'), completedStatus(runId, 'review', {
    gate_decision: 'pass',
  }), cwd);
  writeStageStatus(stageStatusPath('qa'), completedStatus(runId, 'qa'), cwd);
  writeStageStatus(stageStatusPath('ship'), completedStatus(runId, 'ship'), cwd);
  writeStageStatus(stageStatusPath('closeout'), completedStatus(runId, 'closeout'), cwd);
  writeRepoFile(cwd, CLOSEOUT_RECORD_PATH, '# Closeout Record\n\nBase closeout content.\n');
  return runId;
}

describe('follow-on summary refresh', () => {
  test('refreshes closeout-owned follow-on artifacts after post-closeout evidence arrives', () => {
    withTempRepo((cwd) => {
      const runId = seedCloseout(cwd);
      writeRepoFile(cwd, qaPerfVerificationPath(), '# Perf Verification\n\n- P95 stayed under budget.\n');
      writeRepoJson(cwd, shipCanaryStatusPath(), {
        status: 'healthy',
        summary: 'Canary stayed clean.',
      });
      writeRepoJson(cwd, shipDeployResultPath(), {
        source: 'land-and-deploy',
        merge_status: 'pending',
        deploy_status: 'failed',
        verification_status: 'skipped',
        failure_kind: 'pre_merge_ci_failed',
        next_action: 'rerun_build_review_qa_ship',
        ship_handoff_current: true,
        ship_handoff_head_sha: 'abc123',
        pull_request_head_sha: 'def456',
        production_url: 'https://example.com',
        summary: 'Deploy blocked before merge because CI failed.',
      });
      writeRepoFile(cwd, closeoutDocumentationSyncPath(), '# Documentation Sync\n\n- README updated after deploy.\n');

      const result = refreshCurrentCloseoutFollowOnArtifacts(cwd);

      expect(result.status).toBe('updated');
      expect(result.written_paths).toEqual(expect.arrayContaining([
        closeoutFollowOnSummaryJsonPath(),
        closeoutFollowOnSummaryMarkdownPath(),
        closeoutNextRunBootstrapJsonPath(),
        CLOSEOUT_RECORD_PATH,
      ]));
      expect(readRepoJson(cwd, closeoutFollowOnSummaryJsonPath())).toMatchObject({
        source_artifacts: [
          qaPerfVerificationPath(),
          shipCanaryStatusPath(),
          shipDeployResultPath(),
          closeoutDocumentationSyncPath(),
        ],
        evidence: {
          ship: {
            deploy_status: 'failed',
            verification_status: 'skipped',
            landing_reentry: {
              deploy_result_path: shipDeployResultPath(),
              merge_status: 'pending',
              deploy_status: 'failed',
              verification_status: 'skipped',
              failure_kind: 'pre_merge_ci_failed',
              next_action: 'rerun_build_review_qa_ship',
              ship_handoff_current: true,
              ship_handoff_head_sha: 'abc123',
              pull_request_head_sha: 'def456',
            },
          },
        },
      });
      expect(readRepoFile(cwd, closeoutFollowOnSummaryMarkdownPath())).toContain(
        `Deploy result: ${shipDeployResultPath()}`,
      );
      expect(readRepoFile(cwd, CLOSEOUT_RECORD_PATH)).toContain(
        `Deploy result evidence: ${shipDeployResultPath()}`,
      );
      expect(readRepoJson<{
        carry_forward_artifacts: Array<{ path: string }>;
        landing_reentry: { next_action: string | null };
      }>(cwd, closeoutNextRunBootstrapJsonPath())).toMatchObject({
        landing_reentry: {
          next_action: 'rerun_build_review_qa_ship',
        },
        carry_forward_artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: `.planning/archive/runs/${runId}/ship/deploy-result.json`,
          }),
        ]),
      });
    });
  });

  test('skips cleanly when no active closeout exists', () => {
    withTempRepo((cwd) => {
      expect(refreshCurrentCloseoutFollowOnArtifacts(cwd)).toEqual({
        status: 'skipped',
        reason: 'no_active_closeout',
        written_paths: [],
      });
    });
  });
});
