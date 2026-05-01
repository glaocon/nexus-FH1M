import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  closeoutDocumentationSyncPath,
  closeoutFollowOnSummaryJsonPath,
  closeoutFollowOnSummaryMarkdownPath,
  closeoutNextRunBootstrapJsonPath,
  closeoutNextRunMarkdownPath,
  qaPerfVerificationPath,
  shipCanaryStatusPath,
  shipDeployResultPath,
  stageStatusPath,
} from '../../lib/nexus/artifacts';
import {
  readLandingReentryGuidance,
  refreshCurrentCloseoutFollowOnArtifacts,
} from '../../lib/nexus/closeout-follow-on-refresh';
import type { ExecutionSelection } from '../../lib/nexus/execution-topology';
import { readLedger, startLedger, writeLedger } from '../../lib/nexus/ledger';
import { writeStageStatus } from '../../lib/nexus/status';
import type { ArtifactPointer, CanonicalCommandId, StageDecision, StageStatus } from '../../lib/nexus/types';

const CLOSEOUT_RECORD_PATH = '.planning/current/closeout/CLOSEOUT-RECORD.md';
const TEST_EXECUTION: ExecutionSelection = {
  mode: 'local_provider',
  primary_provider: 'codex',
  provider_topology: 'single_agent',
  requested_execution_path: '.',
};
const tempRepos: string[] = [];

function makeTempRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'nexus-closeout-refresh-'));
  tempRepos.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempRepos.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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

function completedStatus(
  runId: string,
  stage: CanonicalCommandId,
  overrides: Partial<StageStatus> = {},
): StageStatus {
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

function setupActiveCloseout(cwd: string, options: {
  runId?: string;
  withReviewStatus?: boolean;
  withCloseoutRecord?: boolean;
} = {}): string {
  const runId = options.runId ?? 'run-phase-3-closeout-refresh';
  const ledger = {
    ...startLedger(runId, 'closeout', TEST_EXECUTION),
    status: 'completed',
    current_command: 'closeout',
    current_stage: 'closeout',
    previous_stage: 'ship',
    allowed_next_stages: [],
    artifact_index: {
      '.planning/current/closeout/existing.md': {
        kind: 'markdown',
        path: '.planning/current/closeout/existing.md',
      } satisfies ArtifactPointer,
    },
  };

  writeLedger(ledger, cwd);
  writeStageStatus(stageStatusPath('closeout'), completedStatus(runId, 'closeout'), cwd);

  if (options.withReviewStatus !== false) {
    writeStageStatus(stageStatusPath('review'), completedStatus(runId, 'review', {
      gate_decision: 'pass',
    }), cwd);
  }

  writeStageStatus(stageStatusPath('qa'), completedStatus(runId, 'qa'), cwd);
  writeStageStatus(stageStatusPath('ship'), completedStatus(runId, 'ship'), cwd);

  if (options.withCloseoutRecord !== false) {
    writeRepoFile(
      cwd,
      CLOSEOUT_RECORD_PATH,
      [
        '# Closeout Record',
        '',
        'Base closeout content.',
        '',
        '## Attached Evidence',
        '',
        '- stale evidence that should be replaced',
        '',
        '## Landing Re-entry',
        '',
        '- stale landing guidance',
        '',
      ].join('\n'),
    );
  }

  return runId;
}

describe('readLandingReentryGuidance', () => {
  test('returns null when no deploy result is available', () => {
    const cwd = makeTempRepo();

    expect(readLandingReentryGuidance(cwd, null)).toBeNull();
    expect(readLandingReentryGuidance(cwd, shipDeployResultPath())).toBeNull();
  });

  test('preserves the deploy result path when the JSON is malformed', () => {
    const cwd = makeTempRepo();
    writeRepoFile(cwd, shipDeployResultPath(), '{not valid json');

    expect(readLandingReentryGuidance(cwd, shipDeployResultPath())).toEqual({
      deploy_result_path: shipDeployResultPath(),
      merge_status: null,
      deploy_status: null,
      verification_status: null,
      failure_kind: null,
      next_action: null,
      ship_handoff_current: null,
      ship_handoff_head_sha: null,
      pull_request_head_sha: null,
    });
  });
});

describe('refreshCurrentCloseoutFollowOnArtifacts', () => {
  test('skips when no active closeout ledger and status are present', () => {
    const cwd = makeTempRepo();

    expect(refreshCurrentCloseoutFollowOnArtifacts(cwd)).toEqual({
      status: 'skipped',
      reason: 'no_active_closeout',
      written_paths: [],
    });
    expect(existsSync(join(cwd, closeoutFollowOnSummaryJsonPath()))).toBe(false);
  });

  test('skips when the active closeout has no matching review status', () => {
    const cwd = makeTempRepo();
    setupActiveCloseout(cwd, { withReviewStatus: false });

    expect(refreshCurrentCloseoutFollowOnArtifacts(cwd)).toEqual({
      status: 'skipped',
      reason: 'missing_review_status',
      written_paths: [],
    });
    expect(existsSync(join(cwd, closeoutNextRunBootstrapJsonPath()))).toBe(false);
  });

  test('writes follow-on artifacts, landing re-entry, and artifact index entries once', () => {
    const cwd = makeTempRepo();
    const runId = setupActiveCloseout(cwd);

    writeRepoFile(cwd, qaPerfVerificationPath(), '# Perf Verification\n\nP95 stayed under budget.\n');
    writeRepoJson(cwd, shipCanaryStatusPath(), {
      status: 'degraded',
      summary: 'Canary surfaced a warning.',
    });
    writeRepoJson(cwd, shipDeployResultPath(), {
      source: 'land-and-deploy',
      merge_status: 'pending',
      deploy_status: 'failed',
      verification_status: 'skipped',
      failure_kind: 'pre_merge_ci_failed',
      next_action: 'rerun_build_review_qa_ship',
      ship_handoff_current: false,
      ship_handoff_head_sha: 'handoff123',
      pull_request_head_sha: 'head456',
      production_url: 'https://example.invalid',
    });
    writeRepoFile(cwd, closeoutDocumentationSyncPath(), '# Documentation Sync\n\nDocs were refreshed.\n');

    const result = refreshCurrentCloseoutFollowOnArtifacts(cwd);

    expect(result).toMatchObject({
      status: 'updated',
      reason: 'refreshed',
    });
    expect(result.written_paths).toEqual(expect.arrayContaining([
      closeoutFollowOnSummaryMarkdownPath(),
      closeoutFollowOnSummaryJsonPath(),
      closeoutNextRunMarkdownPath(),
      closeoutNextRunBootstrapJsonPath(),
      CLOSEOUT_RECORD_PATH,
    ]));

    const summary = readRepoJson<{
      source_artifacts: string[];
      evidence: {
        ship: {
          deploy_status: string | null;
          verification_status: string | null;
          landing_reentry: {
            deploy_result_path: string;
            merge_status: string | null;
            deploy_status: string | null;
            verification_status: string | null;
            failure_kind: string | null;
            next_action: string | null;
            ship_handoff_current: boolean | null;
            ship_handoff_head_sha: string | null;
            pull_request_head_sha: string | null;
          } | null;
        };
      };
    }>(cwd, closeoutFollowOnSummaryJsonPath());
    expect(summary.source_artifacts).toEqual([
      qaPerfVerificationPath(),
      shipCanaryStatusPath(),
      shipDeployResultPath(),
      closeoutDocumentationSyncPath(),
    ]);
    expect(summary.evidence.ship).toMatchObject({
      deploy_status: 'failed',
      verification_status: 'skipped',
      landing_reentry: {
        deploy_result_path: shipDeployResultPath(),
        merge_status: 'pending',
        deploy_status: 'failed',
        verification_status: 'skipped',
        failure_kind: 'pre_merge_ci_failed',
        next_action: 'rerun_build_review_qa_ship',
        ship_handoff_current: false,
        ship_handoff_head_sha: 'handoff123',
        pull_request_head_sha: 'head456',
      },
    });

    const summaryMarkdown = readRepoFile(cwd, closeoutFollowOnSummaryMarkdownPath());
    expect(summaryMarkdown.match(/^## Landing Re-entry$/gm)).toHaveLength(1);
    expect(summaryMarkdown).toContain(`- Deploy result: ${shipDeployResultPath()}`);
    expect(summaryMarkdown).toContain('- Deploy status: failed');
    expect(summaryMarkdown).toContain('- PR head SHA: head456');

    const closeoutRecord = readRepoFile(cwd, CLOSEOUT_RECORD_PATH);
    expect(closeoutRecord).not.toContain('stale evidence');
    expect(closeoutRecord).toContain(`Deploy result evidence: ${shipDeployResultPath()}`);
    expect(closeoutRecord).toContain('- Ship handoff current: no');
    expect(closeoutRecord.match(/^## Attached Evidence$/gm)).toHaveLength(1);
    expect(closeoutRecord.match(/^## Landing Re-entry$/gm)).toHaveLength(1);

    const bootstrap = readRepoJson<{
      landing_reentry: { next_action: string | null; ship_handoff_current: boolean | null } | null;
      carry_forward_artifacts: ArtifactPointer[];
    }>(cwd, closeoutNextRunBootstrapJsonPath());
    expect(bootstrap.landing_reentry).toMatchObject({
      next_action: 'rerun_build_review_qa_ship',
      ship_handoff_current: false,
    });
    expect(bootstrap.carry_forward_artifacts).toEqual(expect.arrayContaining([
      {
        kind: 'json',
        path: `.planning/archive/runs/${runId}/ship/deploy-result.json`,
      },
      {
        kind: 'markdown',
        path: `.planning/archive/runs/${runId}/closeout/documentation-sync.md`,
      },
    ]));

    const refreshedLedger = readLedger(cwd);
    expect(refreshedLedger?.artifact_index[closeoutFollowOnSummaryMarkdownPath()]).toEqual({
      kind: 'markdown',
      path: closeoutFollowOnSummaryMarkdownPath(),
    });
    expect(refreshedLedger?.artifact_index[closeoutFollowOnSummaryJsonPath()]).toEqual({
      kind: 'json',
      path: closeoutFollowOnSummaryJsonPath(),
    });
    expect(refreshedLedger?.artifact_index[closeoutNextRunMarkdownPath()]).toEqual({
      kind: 'markdown',
      path: closeoutNextRunMarkdownPath(),
    });
    expect(refreshedLedger?.artifact_index[closeoutNextRunBootstrapJsonPath()]).toEqual({
      kind: 'json',
      path: closeoutNextRunBootstrapJsonPath(),
    });
  });
});
