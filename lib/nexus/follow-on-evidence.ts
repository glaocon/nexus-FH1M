import { join } from 'path';
import type {
  CanaryEvidenceStatus,
  CanaryStatusRecord,
  DeployResultRecord,
  FollowOnEvidenceSummaryRecord,
} from './types';
import { readJsonPartial } from './validation-helpers';

function readCanaryEvidence(
  cwd: string,
  canaryEvidencePath: string | null,
): { path: string | null; status: CanaryEvidenceStatus | null } {
  if (!canaryEvidencePath) {
    return { path: null, status: null };
  }

  const record = readJsonPartial<CanaryStatusRecord>(join(cwd, canaryEvidencePath));
  const status = record?.status;

  return {
    path: canaryEvidencePath,
    status: status === 'healthy' || status === 'degraded' || status === 'broken' ? status : null,
  };
}

function readDeployEvidence(
  cwd: string,
  deployResultPath: string | null,
): {
  path: string | null;
  mergeStatus: DeployResultRecord['merge_status'] | null;
  deployStatus: DeployResultRecord['deploy_status'] | null;
  verificationStatus: DeployResultRecord['verification_status'] | null;
  failureKind: DeployResultRecord['failure_kind'] | null;
  nextAction: DeployResultRecord['next_action'] | null;
  shipHandoffCurrent: boolean | null;
  shipHandoffHeadSha: string | null;
  pullRequestHeadSha: string | null;
  productionUrl: string | null;
} {
  if (!deployResultPath) {
    return {
      path: null,
      mergeStatus: null,
      deployStatus: null,
      verificationStatus: null,
      failureKind: null,
      nextAction: null,
      shipHandoffCurrent: null,
      shipHandoffHeadSha: null,
      pullRequestHeadSha: null,
      productionUrl: null,
    };
  }

  const record = readJsonPartial<DeployResultRecord>(join(cwd, deployResultPath));
  const mergeStatus = record?.merge_status;
  const deployStatus = record?.deploy_status;
  const verificationStatus = record?.verification_status;
  const failureKind = record?.failure_kind;
  const nextAction = record?.next_action;

  return {
    path: deployResultPath,
    mergeStatus:
      mergeStatus === 'pending'
      || mergeStatus === 'merged'
      || mergeStatus === 'reverted'
        ? mergeStatus
        : null,
    deployStatus:
      deployStatus === 'pending'
      || deployStatus === 'verified'
      || deployStatus === 'degraded'
      || deployStatus === 'failed'
      || deployStatus === 'skipped'
        ? deployStatus
        : null,
    verificationStatus:
      verificationStatus === 'healthy'
      || verificationStatus === 'degraded'
      || verificationStatus === 'broken'
      || verificationStatus === 'skipped'
        ? verificationStatus
        : null,
    failureKind:
      failureKind === 'pre_merge_ci_failed'
      || failureKind === 'pre_merge_conflict'
      || failureKind === 'merge_queue_failed'
      || failureKind === 'post_merge_deploy_failed'
        ? failureKind
        : null,
    nextAction:
      nextAction === 'rerun_land_and_deploy'
      || nextAction === 'rerun_ship'
      || nextAction === 'rerun_build_review_qa_ship'
      || nextAction === 'investigate_deploy'
      || nextAction === 'revert'
        ? nextAction
        : null,
    shipHandoffCurrent: typeof record?.ship_handoff_current === 'boolean' ? record.ship_handoff_current : null,
    shipHandoffHeadSha: typeof record?.ship_handoff_head_sha === 'string' ? record.ship_handoff_head_sha : null,
    pullRequestHeadSha: typeof record?.pull_request_head_sha === 'string' ? record.pull_request_head_sha : null,
    productionUrl: typeof record?.production_url === 'string' ? record.production_url : null,
  };
}

export function buildFollowOnEvidenceSummary(input: {
  cwd: string;
  runId: string;
  generatedAt: string;
  perfVerificationPath: string | null;
  canaryEvidencePath: string | null;
  deployResultPath: string | null;
  documentationSyncPath: string | null;
}): FollowOnEvidenceSummaryRecord {
  const canaryEvidence = readCanaryEvidence(input.cwd, input.canaryEvidencePath);
  const deployEvidence = readDeployEvidence(input.cwd, input.deployResultPath);
  const sourceArtifacts = [
    input.perfVerificationPath,
    input.canaryEvidencePath,
    input.deployResultPath,
    input.documentationSyncPath,
  ].filter((artifactPath): artifactPath is string => Boolean(artifactPath));

  const summaryParts: string[] = [];
  if (input.perfVerificationPath) {
    summaryParts.push('QA performance evidence recorded.');
  }
  if (canaryEvidence.path) {
    summaryParts.push(`Ship canary evidence recorded${canaryEvidence.status ? ` (${canaryEvidence.status})` : ''}.`);
  }
  if (deployEvidence.path) {
    summaryParts.push(
      `Deploy result recorded${deployEvidence.deployStatus ? ` (${deployEvidence.deployStatus})` : ''}.`,
    );
    if (deployEvidence.nextAction) {
      summaryParts.push(`Landing re-entry next action: ${deployEvidence.nextAction}.`);
    }
    if (deployEvidence.failureKind) {
      summaryParts.push(`Landing failure kind: ${deployEvidence.failureKind}.`);
    }
    if (deployEvidence.shipHandoffCurrent === false) {
      summaryParts.push('Ship handoff is stale against the current PR head.');
    } else if (deployEvidence.shipHandoffCurrent === true) {
      summaryParts.push('Ship handoff still matches the current PR head.');
    }
  }
  if (input.documentationSyncPath) {
    summaryParts.push('Documentation sync evidence recorded.');
  }

  return {
    schema_version: 1,
    run_id: input.runId,
    generated_at: input.generatedAt,
    source_artifacts: sourceArtifacts,
    evidence: {
      qa: {
        perf_verification_path: input.perfVerificationPath,
      },
      ship: {
        canary_status_path: canaryEvidence.path,
        canary_status: canaryEvidence.status,
        deploy_result_path: deployEvidence.path,
        deploy_status: deployEvidence.deployStatus,
        verification_status: deployEvidence.verificationStatus,
        production_url: deployEvidence.productionUrl,
      },
      closeout: {
        documentation_sync_path: input.documentationSyncPath,
      },
    },
    summary: summaryParts.length > 0
      ? summaryParts.join(' ')
      : 'No attached follow-on evidence was recorded for this run.',
  };
}

function renderLandingReentryBlock(record: FollowOnEvidenceSummaryRecord): string[] {
  const shipEvidence = record.evidence.ship as FollowOnEvidenceSummaryRecord['evidence']['ship'] & {
    landing_reentry?: {
      deploy_result_path?: string | null;
      merge_status: string | null;
      deploy_status?: string | null;
      verification_status?: string | null;
      failure_kind: string | null;
      next_action: string | null;
      ship_handoff_current: boolean | null;
      ship_handoff_head_sha: string | null;
      pull_request_head_sha: string | null;
    } | null;
  };
  const landingReentry = shipEvidence.landing_reentry ?? null;

  if (!landingReentry) {
    return [];
  }

  return [
    '## Landing Re-entry',
    '',
    `- Deploy result: ${landingReentry.deploy_result_path ?? shipEvidence.deploy_result_path ?? 'unknown'}`,
    `- Merge status: ${landingReentry.merge_status ?? 'unknown'}`,
    `- Deploy status: ${landingReentry.deploy_status ?? shipEvidence.deploy_status ?? 'unknown'}`,
    `- Verification status: ${landingReentry.verification_status ?? shipEvidence.verification_status ?? 'unknown'}`,
    `- Failure kind: ${landingReentry.failure_kind ?? 'unknown'}`,
    `- Next action: ${landingReentry.next_action ?? 'none'}`,
    `- Ship handoff current: ${
      landingReentry.ship_handoff_current === true
        ? 'yes'
        : landingReentry.ship_handoff_current === false
          ? 'no'
          : 'unknown'
    }`,
    `- Ship handoff head SHA: ${landingReentry.ship_handoff_head_sha ?? 'unknown'}`,
    `- PR head SHA: ${landingReentry.pull_request_head_sha ?? 'unknown'}`,
    '',
  ];
}

export function renderFollowOnEvidenceMarkdown(record: FollowOnEvidenceSummaryRecord): string {
  return [
    '# Follow-On Evidence Summary',
    '',
    `- Run: ${record.run_id}`,
    `- Generated at: ${record.generated_at}`,
    '',
    '## Summary',
    '',
    record.summary,
    '',
    '## Evidence Index',
    '',
    `- QA perf verification: ${record.evidence.qa.perf_verification_path ?? 'none'}`,
    `- Ship canary evidence: ${record.evidence.ship.canary_status_path ?? 'none'}${record.evidence.ship.canary_status ? ` (${record.evidence.ship.canary_status})` : ''}`,
    `- Deploy result: ${record.evidence.ship.deploy_result_path ?? 'none'}${record.evidence.ship.deploy_status ? ` (${record.evidence.ship.deploy_status})` : ''}`,
    `- Documentation sync: ${record.evidence.closeout.documentation_sync_path ?? 'none'}`,
    '',
    ...renderLandingReentryBlock(record),
    '## Source Artifacts',
    '',
    ...(record.source_artifacts.length > 0
      ? record.source_artifacts.map((artifact) => `- ${artifact}`)
      : ['- none']),
    '',
  ].join('\n');
}
