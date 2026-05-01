import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
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
} from './artifacts';
import { buildFollowOnEvidenceSummary, renderFollowOnEvidenceMarkdown } from './follow-on-evidence';
import { readLedger, writeLedger } from './ledger';
import { buildNextRunBootstrap, renderNextRunBootstrapMarkdown } from './run-bootstrap';
import { readStageStatus } from './status';
import type { ArtifactPointer, FollowOnEvidenceSummaryRecord, RunLedger } from './types';
import { readJsonPartial } from './validation-helpers';

const CLOSEOUT_RECORD_PATH = '.planning/current/closeout/CLOSEOUT-RECORD.md';

export interface LandingReentryGuidance {
  deploy_result_path: string;
  merge_status: string | null;
  deploy_status: string | null;
  verification_status: string | null;
  failure_kind: string | null;
  next_action: string | null;
  ship_handoff_current: boolean | null;
  ship_handoff_head_sha: string | null;
  pull_request_head_sha: string | null;
}

function artifactPointerFor(path: string): ArtifactPointer {
  return {
    kind: path.endsWith('.json') ? 'json' : 'markdown',
    path,
  };
}

function attachedEvidencePathIfPresent(cwd: string, path: string): string | null {
  return existsSync(join(cwd, path)) ? path : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

export function readLandingReentryGuidance(
  cwd: string,
  deployResultPath: string | null,
): LandingReentryGuidance | null {
  if (!deployResultPath) {
    return null;
  }

  const absolutePath = join(cwd, deployResultPath);
  if (!existsSync(absolutePath)) {
    return null;
  }

  // For parse errors, callers want a populated shell (not null) so the deploy
  // path stays visible — matches the previous `try/catch → all-null shell`
  // shape. The shell shares structure with the success branch, just with each
  // best-effort field nulled out.
  const record = readJsonPartial<Record<string, unknown>>(absolutePath);
  return {
    deploy_result_path: deployResultPath,
    merge_status: readString(record, 'merge_status'),
    deploy_status: readString(record, 'deploy_status'),
    verification_status: readString(record, 'verification_status'),
    failure_kind: readString(record, 'failure_kind'),
    next_action: readString(record, 'next_action'),
    ship_handoff_current: readBoolean(record, 'ship_handoff_current'),
    ship_handoff_head_sha: readString(record, 'ship_handoff_head_sha'),
    pull_request_head_sha: readString(record, 'pull_request_head_sha'),
  };
}

export function renderLandingReentryMarkdown(guidance: LandingReentryGuidance | null): string {
  if (!guidance) {
    return '';
  }

  return [
    '',
    '## Landing Re-entry',
    '',
    `- Deploy result: ${guidance.deploy_result_path}`,
    `- Merge status: ${guidance.merge_status ?? 'unknown'}`,
    `- Deploy status: ${guidance.deploy_status ?? 'unknown'}`,
    `- Verification status: ${guidance.verification_status ?? 'unknown'}`,
    `- Failure kind: ${guidance.failure_kind ?? 'unknown'}`,
    `- Next action: ${guidance.next_action ?? 'none'}`,
    `- Ship handoff current: ${
      guidance.ship_handoff_current === true
        ? 'yes'
        : guidance.ship_handoff_current === false
          ? 'no'
          : 'unknown'
    }`,
    `- Ship handoff head SHA: ${guidance.ship_handoff_head_sha ?? 'unknown'}`,
    `- PR head SHA: ${guidance.pull_request_head_sha ?? 'unknown'}`,
    '',
  ].join('\n');
}

export function enrichFollowOnEvidenceSummary(
  summary: FollowOnEvidenceSummaryRecord,
  guidance: LandingReentryGuidance | null,
): FollowOnEvidenceSummaryRecord & {
  evidence: FollowOnEvidenceSummaryRecord['evidence'] & {
    ship: FollowOnEvidenceSummaryRecord['evidence']['ship'] & {
      landing_reentry: LandingReentryGuidance | null;
    };
  };
} {
  return {
    ...summary,
    evidence: {
      ...summary.evidence,
      ship: {
        ...summary.evidence.ship,
        landing_reentry: guidance,
      },
    },
  };
}

function renderAttachedEvidenceBlock(input: {
  perfVerificationPath: string | null;
  canaryEvidencePath: string | null;
  deployResultPath: string | null;
  documentationSyncPath: string | null;
}): string {
  if (
    !input.perfVerificationPath
    && !input.canaryEvidencePath
    && !input.deployResultPath
    && !input.documentationSyncPath
  ) {
    return '';
  }

  return [
    '',
    '## Attached Evidence',
    '',
    `- QA perf verification: ${input.perfVerificationPath ?? 'none'}`,
    `- Ship canary evidence: ${input.canaryEvidencePath ?? 'none'}`,
    `- Deploy result evidence: ${input.deployResultPath ?? 'none'}`,
    `- Documentation sync evidence: ${input.documentationSyncPath ?? 'none'}`,
    '',
  ].join('\n');
}

function refreshCloseoutRecord(
  cwd: string,
  evidence: {
    perfVerificationPath: string | null;
    canaryEvidencePath: string | null;
    deployResultPath: string | null;
    documentationSyncPath: string | null;
  },
  landingReentry: LandingReentryGuidance | null,
): boolean {
  const absolutePath = join(cwd, CLOSEOUT_RECORD_PATH);
  if (!existsSync(absolutePath)) {
    return false;
  }

  const baseContent = readFileSync(absolutePath, 'utf8').replace(/\n## Attached Evidence[\s\S]*$/m, '').trimEnd();
  const nextContent = `${baseContent}${renderAttachedEvidenceBlock(evidence)}${renderLandingReentryMarkdown(landingReentry)}\n`;
  if (readFileSync(absolutePath, 'utf8') === nextContent) {
    return false;
  }
  writeFileSync(absolutePath, nextContent);
  return true;
}

function refreshArtifactIndex(ledger: RunLedger): RunLedger {
  const nextArtifactIndex = { ...ledger.artifact_index };
  nextArtifactIndex[CLOSEOUT_RECORD_PATH] = artifactPointerFor(CLOSEOUT_RECORD_PATH);
  nextArtifactIndex[closeoutFollowOnSummaryMarkdownPath()] = artifactPointerFor(closeoutFollowOnSummaryMarkdownPath());
  nextArtifactIndex[closeoutFollowOnSummaryJsonPath()] = artifactPointerFor(closeoutFollowOnSummaryJsonPath());
  nextArtifactIndex[closeoutNextRunMarkdownPath()] = artifactPointerFor(closeoutNextRunMarkdownPath());
  nextArtifactIndex[closeoutNextRunBootstrapJsonPath()] = artifactPointerFor(closeoutNextRunBootstrapJsonPath());

  return {
    ...ledger,
    artifact_index: nextArtifactIndex,
  };
}

export interface RefreshCloseoutFollowOnResult {
  status: 'updated' | 'skipped';
  reason: 'refreshed' | 'no_active_closeout' | 'missing_review_status';
  written_paths: string[];
}

export function refreshCurrentCloseoutFollowOnArtifacts(cwd: string): RefreshCloseoutFollowOnResult {
  const ledger = readLedger(cwd);
  const closeoutStatus = readStageStatus(stageStatusPath('closeout'), cwd);

  if (!ledger || !closeoutStatus || closeoutStatus.run_id !== ledger.run_id || closeoutStatus.stage !== 'closeout') {
    return {
      status: 'skipped',
      reason: 'no_active_closeout',
      written_paths: [],
    };
  }

  const reviewStatus = readStageStatus(stageStatusPath('review'), cwd);
  if (!reviewStatus || reviewStatus.run_id !== ledger.run_id) {
    return {
      status: 'skipped',
      reason: 'missing_review_status',
      written_paths: [],
    };
  }

  const qaStatus = readStageStatus(stageStatusPath('qa'), cwd);
  const shipStatus = readStageStatus(stageStatusPath('ship'), cwd);
  const perfVerificationPath = attachedEvidencePathIfPresent(cwd, qaPerfVerificationPath());
  const canaryEvidencePath = attachedEvidencePathIfPresent(cwd, shipCanaryStatusPath());
  const deployResultPath = attachedEvidencePathIfPresent(cwd, shipDeployResultPath());
  const documentationSyncPath = attachedEvidencePathIfPresent(cwd, closeoutDocumentationSyncPath());
  const landingReentry = readLandingReentryGuidance(cwd, deployResultPath);
  const refreshedAt = new Date().toISOString();
  const qaStatusForRun = qaStatus && qaStatus.run_id === ledger.run_id ? qaStatus : null;
  const shipStatusForRun = shipStatus && shipStatus.run_id === ledger.run_id ? shipStatus : null;

  const followOnSummary = enrichFollowOnEvidenceSummary(buildFollowOnEvidenceSummary({
    cwd,
    runId: ledger.run_id,
    generatedAt: refreshedAt,
    perfVerificationPath,
    canaryEvidencePath,
    deployResultPath,
    documentationSyncPath,
  }), landingReentry);
  const bootstrap = buildNextRunBootstrap({
    ledger,
    reviewStatus,
    qaStatus: qaStatusForRun,
    shipStatus: shipStatusForRun,
    generatedAt: refreshedAt,
    followOnSummaryRecorded: true,
    canaryEvidencePath,
    documentationSyncPath,
    deployResultPath,
    landingReentry,
  });

  const writes: Array<{ path: string; content: string }> = [
    {
      path: closeoutFollowOnSummaryMarkdownPath(),
      content: renderFollowOnEvidenceMarkdown(followOnSummary),
    },
    {
      path: closeoutFollowOnSummaryJsonPath(),
      content: JSON.stringify(followOnSummary, null, 2) + '\n',
    },
    {
      path: closeoutNextRunMarkdownPath(),
      content: renderNextRunBootstrapMarkdown(bootstrap),
    },
    {
      path: closeoutNextRunBootstrapJsonPath(),
      content: JSON.stringify(bootstrap, null, 2) + '\n',
    },
  ];

  const writtenPaths: string[] = [];
  for (const write of writes) {
    const absolutePath = join(cwd, write.path);
    const previousContent = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
    if (previousContent !== write.content) {
      writeFileSync(absolutePath, write.content);
      writtenPaths.push(write.path);
    }
  }

  if (refreshCloseoutRecord(cwd, {
    perfVerificationPath,
    canaryEvidencePath,
    deployResultPath,
    documentationSyncPath,
  }, landingReentry)) {
    writtenPaths.push(CLOSEOUT_RECORD_PATH);
  }

  const nextLedger = refreshArtifactIndex(ledger);
  if (JSON.stringify(nextLedger.artifact_index) !== JSON.stringify(ledger.artifact_index)) {
    writeLedger(nextLedger, cwd);
  }

  return {
    status: 'updated',
    reason: 'refreshed',
    written_paths: writtenPaths,
  };
}
