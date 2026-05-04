import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  closeoutDocumentationSyncPath,
  currentAttachedEvidencePaths,
  currentAuditArtifactPaths,
  qaPerfVerificationPath,
  reviewAdvisoriesPath,
  reviewAdvisoryDispositionPath,
  shipCanaryStatusPath,
  shipDeployResultPath,
  stageCompletionAdvisorPath,
  stageStatusPath,
} from './artifacts';
import { buildCompletionAdvisorWrite, buildReviewCompletionAdvisor } from './completion-advisor';
import { artifactPointerFor } from './contract-artifacts';
import { diagnoseCloseoutHistory } from './governance';
import { readLedger, writeLedger } from './ledger';
import {
  buildReviewAdvisoriesRecord,
  buildReviewAdvisoryDispositionRecord,
  readReviewAdvisories,
} from './review-advisories';
import {
  listReviewAttemptIds,
  listReviewAttemptReceiptPaths,
  readReviewAuditReceipt,
} from './review-receipts';
import { readStageStatus } from './status';
import { readVerificationMatrix } from './verification-matrix';
import { isRecord } from './validation-helpers';
import type { StageStatus } from './types';

export const LEDGER_DOCTOR_ISSUE_CODES = [
  'history_mismatch',
  'stale_current_audits',
  'split_brain_current_audits',
  'current_audit_read_failed',
  'stale_review_receipts',
  'stale_attached_evidence',
  'review_advisory_drift',
] as const;

export type LedgerDoctorIssueCode = (typeof LEDGER_DOCTOR_ISSUE_CODES)[number];

export interface LedgerDoctorIssue {
  code: LedgerDoctorIssueCode;
  message: string;
  evidence: string[];
}

export interface LedgerDoctorReport {
  status: 'clean' | 'action_required';
  issues: LedgerDoctorIssue[];
}

export interface LedgerDoctorSafeFixResult {
  report: LedgerDoctorReport;
  fixed_paths: string[];
  fixed_issue_codes: LedgerDoctorIssueCode[];
}

function currentAuditArtifactsPresent(rootDir: string): string[] {
  return currentAuditArtifactPaths().filter((path) => existsSync(join(rootDir, path)));
}

function parseAuditVerdict(markdown: string): 'pass' | 'fail' | null {
  const matches = [...markdown.matchAll(/Result:\s*(pass|fail)/gi)];
  const verdict = matches.at(-1)?.[1]?.toLowerCase();
  return verdict === 'pass' || verdict === 'fail' ? verdict : null;
}

function parseGateDecision(markdown: string): 'pass' | 'fail' | 'blocked' | null {
  const match = markdown.match(/Gate:\s*(pass|fail|blocked)/i);
  const verdict = match?.[1]?.toLowerCase();
  return verdict === 'pass' || verdict === 'fail' || verdict === 'blocked' ? verdict : null;
}

function parseSynthesisAuditVerdict(markdown: string, provider: 'Codex' | 'Gemini'): 'pass' | 'fail' | null {
  const match = markdown.match(new RegExp(`${provider} audit result:\\s*(pass|fail)`, 'i'));
  const verdict = match?.[1]?.toLowerCase();
  return verdict === 'pass' || verdict === 'fail' ? verdict : null;
}

type CurrentAuditMeta = {
  review_attempt_id?: unknown;
  audits?: {
    codex?: { request_id?: unknown };
    gemini?: { request_id?: unknown };
  };
};

type CurrentAuditConsistency =
  | { state: 'consistent' }
  | { state: 'split_brain' }
  | { state: 'read_failed'; message: string };

function parseAuditRequestMeta(value: unknown): { request_id?: unknown } | undefined {
  return isRecord(value) ? { request_id: value.request_id } : undefined;
}

function readCurrentAuditMeta(path: string): CurrentAuditMeta | null {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    return null;
  }

  const audits = isRecord(parsed.audits) ? parsed.audits : {};
  if (typeof parsed.review_attempt_id !== 'string') {
    return null;
  }

  return {
    review_attempt_id: parsed.review_attempt_id,
    audits: {
      codex: parseAuditRequestMeta(audits.codex),
      gemini: parseAuditRequestMeta(audits.gemini),
    },
  };
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diagnoseCurrentAuditConsistency(rootDir: string, reviewStatus: StageStatus): CurrentAuditConsistency {
  const requiredPaths = currentAuditArtifactPaths();
  if (!requiredPaths.every((path) => existsSync(join(rootDir, path)))) {
    return { state: 'split_brain' };
  }

  try {
    const codexMarkdown = readFileSync(join(rootDir, '.planning/audits/current/codex.md'), 'utf8');
    const geminiMarkdown = readFileSync(join(rootDir, '.planning/audits/current/gemini.md'), 'utf8');
    const gateDecisionMarkdown = readFileSync(join(rootDir, '.planning/audits/current/gate-decision.md'), 'utf8');
    const synthesisMarkdown = readFileSync(join(rootDir, '.planning/audits/current/synthesis.md'), 'utf8');
    const meta = readCurrentAuditMeta(join(rootDir, '.planning/audits/current/meta.json'));
    if (!meta) {
      return { state: 'split_brain' };
    }

    const codexVerdict = parseAuditVerdict(codexMarkdown);
    const geminiVerdict = parseAuditVerdict(geminiMarkdown);
    const gateDecision = parseGateDecision(gateDecisionMarkdown);
    const synthesisCodexVerdict = parseSynthesisAuditVerdict(synthesisMarkdown, 'Codex');
    const synthesisGeminiVerdict = parseSynthesisAuditVerdict(synthesisMarkdown, 'Gemini');
    const derivedGate = codexVerdict && geminiVerdict
      ? (codexVerdict === 'pass' && geminiVerdict === 'pass' ? 'pass' : 'fail')
      : null;
    const inconsistencies: string[] = [];

    if (!codexVerdict || !geminiVerdict || !gateDecision || !synthesisCodexVerdict || !synthesisGeminiVerdict || !derivedGate) {
      inconsistencies.push('missing_or_unparseable_verdict');
    }
    if (derivedGate && gateDecision && gateDecision !== derivedGate) {
      inconsistencies.push('gate_decision_mismatch');
    }
    if (derivedGate && reviewStatus.gate_decision !== derivedGate) {
      inconsistencies.push('status_gate_mismatch');
    }
    if (codexVerdict && synthesisCodexVerdict && synthesisCodexVerdict !== codexVerdict) {
      inconsistencies.push('codex_synthesis_mismatch');
    }
    if (geminiVerdict && synthesisGeminiVerdict && synthesisGeminiVerdict !== geminiVerdict) {
      inconsistencies.push('gemini_synthesis_mismatch');
    }

    const statusAttemptId = reviewStatus.review_attempt_id ?? null;
    const metaAttemptId = typeof meta.review_attempt_id === 'string' ? meta.review_attempt_id : null;
    if (statusAttemptId !== metaAttemptId) {
      inconsistencies.push('review_attempt_mismatch');
    }

    const statusRequestIds = reviewStatus.audit_request_ids ?? null;
    const metaCodexRequestId = typeof meta.audits?.codex?.request_id === 'string' ? meta.audits.codex.request_id : null;
    const metaGeminiRequestId = typeof meta.audits?.gemini?.request_id === 'string' ? meta.audits.gemini.request_id : null;
    if ((statusRequestIds?.codex ?? null) !== metaCodexRequestId) {
      inconsistencies.push('codex_request_id_mismatch');
    }
    if ((statusRequestIds?.gemini ?? null) !== metaGeminiRequestId) {
      inconsistencies.push('gemini_request_id_mismatch');
    }

    return inconsistencies.length > 0 ? { state: 'split_brain' } : { state: 'consistent' };
  } catch (error) {
    return {
      state: 'read_failed',
      message: `Failed to read current audit artifacts: ${describeUnknownError(error)}`,
    };
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

function derivedCurrentReviewAdvisories(rootDir: string, reviewStatus: StageStatus | null): ReturnType<typeof buildReviewAdvisoriesRecord> {
  if (!reviewStatus?.run_id) {
    return null;
  }

  const codexPath = join(rootDir, '.planning/audits/current/codex.md');
  const geminiPath = join(rootDir, '.planning/audits/current/gemini.md');
  if (!existsSync(codexPath) || !existsSync(geminiPath)) {
    return null;
  }

  const generatedAt = typeof reviewStatus.completed_at === 'string'
    ? reviewStatus.completed_at
    : new Date(0).toISOString();
  return buildReviewAdvisoriesRecord(
    reviewStatus.run_id,
    generatedAt,
    readFileSync(codexPath, 'utf8'),
    readFileSync(geminiPath, 'utf8'),
  );
}

function hasReviewAdvisoryDrift(rootDir: string, reviewStatus: StageStatus | null, ledgerRunId: string | null): boolean {
  if (!isCanonicalRecordedReview(reviewStatus, ledgerRunId)) {
    return false;
  }

  const derived = derivedCurrentReviewAdvisories(rootDir, reviewStatus);
  const recorded = readReviewAdvisories(rootDir);
  const statusCount = reviewStatus?.advisory_count ?? 0;
  const statusCategories = [...(reviewStatus?.advisory_categories ?? [])].sort();

  if (!derived) {
    return statusCount > 0 || Boolean(recorded);
  }

  if (statusCount !== derived.advisories.length) {
    return true;
  }
  if (!arraysEqual(statusCategories, [...derived.categories].sort())) {
    return true;
  }
  if (reviewStatus?.advisories_path !== reviewAdvisoriesPath()) {
    return true;
  }
  if (reviewStatus?.advisory_disposition_path !== reviewAdvisoryDispositionPath()) {
    return true;
  }
  if (!recorded || !arraysEqual(recorded.advisories, derived.advisories)) {
    return true;
  }
  return !arraysEqual([...recorded.categories].sort(), [...derived.categories].sort());
}

function reviewReceiptGeneratedAtMillis(rootDir: string, attemptId: string): number | null {
  const receipts = [
    readReviewAuditReceipt({ cwd: rootDir, review_attempt_id: attemptId, provider: 'codex' }),
    readReviewAuditReceipt({ cwd: rootDir, review_attempt_id: attemptId, provider: 'gemini' }),
  ].filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== null);

  if (receipts.length === 0) {
    return null;
  }

  const generatedAtMillis = receipts
    .map((receipt) => Date.parse(receipt.record.generated_at))
    .filter((value) => Number.isFinite(value));

  if (generatedAtMillis.length === 0) {
    return null;
  }

  return Math.max(...generatedAtMillis);
}

function staleReviewReceiptPaths(
  rootDir: string,
  reviewStatus: StageStatus | null,
  ledgerRunId: string | null,
): string[] {
  const attemptIds = listReviewAttemptIds(rootDir);
  if (attemptIds.length === 0) {
    return [];
  }

  const activeAttemptId = reviewStatus?.run_id === ledgerRunId ? (reviewStatus.review_attempt_id ?? null) : null;
  const activeCompletedAtMillis = reviewStatus?.run_id === ledgerRunId && typeof reviewStatus.completed_at === 'string'
    ? Date.parse(reviewStatus.completed_at)
    : NaN;

  return attemptIds.flatMap((attemptId) => {
    if (attemptId === activeAttemptId) {
      return [];
    }

    const attemptPaths = listReviewAttemptReceiptPaths(rootDir, attemptId);
    if (attemptPaths.length === 0) {
      return [];
    }

    if (!activeAttemptId || !Number.isFinite(activeCompletedAtMillis)) {
      return attemptPaths;
    }

    const generatedAtMillis = reviewReceiptGeneratedAtMillis(rootDir, attemptId);
    if (generatedAtMillis === null || generatedAtMillis > activeCompletedAtMillis) {
      return attemptPaths;
    }

    return [];
  });
}

type AttachedEvidenceBinding = {
  path: string;
  ownerStage: 'qa' | 'ship' | 'closeout';
};

const ATTACHED_EVIDENCE_BINDINGS: AttachedEvidenceBinding[] = [
  { path: qaPerfVerificationPath(), ownerStage: 'qa' },
  { path: shipCanaryStatusPath(), ownerStage: 'ship' },
  { path: shipDeployResultPath(), ownerStage: 'ship' },
  { path: closeoutDocumentationSyncPath(), ownerStage: 'closeout' },
];

function currentAttachedEvidencePresent(rootDir: string): string[] {
  return currentAttachedEvidencePaths().filter((path) => existsSync(join(rootDir, path)));
}

function isCanonicalRecordedReview(reviewStatus: StageStatus | null, runId: string | null): boolean {
  return Boolean(
    reviewStatus
      && reviewStatus.stage === 'review'
      && reviewStatus.run_id === runId
      && reviewStatus.state === 'completed'
      && reviewStatus.decision === 'audit_recorded'
      && reviewStatus.review_complete === true
      && reviewStatus.audit_set_complete === true
      && reviewStatus.provenance_consistent === true,
  );
}

function shouldDiagnoseCloseoutHistory(currentStage: string | null | undefined): boolean {
  return currentStage === 'review'
    || currentStage === 'qa'
    || currentStage === 'ship'
    || currentStage === 'closeout';
}

function attachedEvidenceIsCanonical(
  evidencePath: string,
  ledgerRunId: string | null,
  qaStatus: StageStatus | null,
  shipStatus: StageStatus | null,
  closeoutStatus: StageStatus | null,
): boolean {
  const binding = ATTACHED_EVIDENCE_BINDINGS.find((entry) => entry.path === evidencePath);
  if (!binding || !ledgerRunId) {
    return false;
  }

  const ownerStatus = binding.ownerStage === 'qa'
    ? qaStatus
    : binding.ownerStage === 'ship'
      ? shipStatus
      : closeoutStatus;

  return Boolean(ownerStatus && ownerStatus.run_id === ledgerRunId && ownerStatus.stage === binding.ownerStage);
}

function staleAttachedEvidencePaths(input: {
  rootDir: string;
  ledgerRunId: string | null;
  qaStatus: StageStatus | null;
  shipStatus: StageStatus | null;
  closeoutStatus: StageStatus | null;
}): string[] {
  return currentAttachedEvidencePresent(input.rootDir).filter((path) => !attachedEvidenceIsCanonical(
    path,
    input.ledgerRunId,
    input.qaStatus,
    input.shipStatus,
    input.closeoutStatus,
  ));
}

export function buildLedgerDoctorReport(rootDir: string): LedgerDoctorReport {
  const issues: LedgerDoctorIssue[] = [];
  const ledger = readLedger(rootDir);
  const reviewStatus = readStageStatus(stageStatusPath('review'), rootDir);
  const qaStatus = readStageStatus(stageStatusPath('qa'), rootDir);
  const shipStatus = readStageStatus(stageStatusPath('ship'), rootDir);
  const closeoutStatus = readStageStatus(stageStatusPath('closeout'), rootDir);

  if (ledger && shouldDiagnoseCloseoutHistory(ledger.current_stage)) {
    const historyError = diagnoseCloseoutHistory(ledger, {
      qaRecorded: qaStatus?.run_id === ledger.run_id,
      shipRecorded: shipStatus?.run_id === ledger.run_id,
    });

    if (historyError) {
      issues.push({
        code: 'history_mismatch',
        message: historyError,
        evidence: [`.planning/nexus/current-run.json`],
      });
    }
  }

  const currentAuditArtifacts = currentAuditArtifactsPresent(rootDir);
  if (
    shouldDiagnoseCloseoutHistory(ledger?.current_stage)
    && currentAuditArtifacts.length > 0
    && !isCanonicalRecordedReview(reviewStatus, ledger?.run_id ?? null)
  ) {
    const reviewEvidence = reviewStatus ? [stageStatusPath('review')] : [];
    const explanation = reviewStatus
      ? 'Current audit artifacts exist but the review status is not a completed canonical audit record.'
      : 'Current audit artifacts exist but there is no review status for the active run.';
    issues.push({
      code: 'stale_current_audits',
      message: explanation,
      evidence: [...reviewEvidence, ...currentAuditArtifacts],
    });
  }

  const currentAuditConsistency = shouldDiagnoseCloseoutHistory(ledger?.current_stage)
    && currentAuditArtifacts.length > 0
    && reviewStatus
    && isCanonicalRecordedReview(reviewStatus, ledger?.run_id ?? null)
    ? diagnoseCurrentAuditConsistency(rootDir, reviewStatus)
    : null;

  if (currentAuditConsistency?.state === 'read_failed') {
    issues.push({
      code: 'current_audit_read_failed',
      message: currentAuditConsistency.message,
      evidence: [stageStatusPath('review'), ...currentAuditArtifactPaths()],
    });
  } else if (
    shouldDiagnoseCloseoutHistory(ledger?.current_stage)
    && currentAuditArtifacts.length > 0
    && isCanonicalRecordedReview(reviewStatus, ledger?.run_id ?? null)
    && currentAuditConsistency?.state === 'split_brain'
  ) {
    issues.push({
      code: 'split_brain_current_audits',
      message: 'Current audit artifacts are incomplete or internally inconsistent with the canonical review status.',
      evidence: [stageStatusPath('review'), ...currentAuditArtifactPaths()],
    });
  }

  const staleReviewReceipts = staleReviewReceiptPaths(rootDir, reviewStatus, ledger?.run_id ?? null);
  if (shouldDiagnoseCloseoutHistory(ledger?.current_stage) && staleReviewReceipts.length > 0) {
    issues.push({
      code: 'stale_review_receipts',
      message: 'Attempt-scoped review receipts from superseded or orphaned review attempts remain under .planning/current/review/attempts/.',
      evidence: staleReviewReceipts,
    });
  }

  if (
    shouldDiagnoseCloseoutHistory(ledger?.current_stage)
    && currentAuditArtifacts.length > 0
    && hasReviewAdvisoryDrift(rootDir, reviewStatus, ledger?.run_id ?? null)
  ) {
    issues.push({
      code: 'review_advisory_drift',
      message: 'Review audit markdown contains advisories that are not reflected in review status or completion-advisor artifacts.',
      evidence: [
        stageStatusPath('review'),
        '.planning/audits/current/codex.md',
        '.planning/audits/current/gemini.md',
        reviewAdvisoriesPath(),
        reviewAdvisoryDispositionPath(),
        stageCompletionAdvisorPath('review'),
      ],
    });
  }

  const staleAttachedEvidence = staleAttachedEvidencePaths({
    rootDir,
    ledgerRunId: ledger?.run_id ?? null,
    qaStatus,
    shipStatus,
    closeoutStatus,
  });
  if (staleAttachedEvidence.length > 0) {
    issues.push({
      code: 'stale_attached_evidence',
      message: 'Attached follow-on evidence exists but the owning stage status is missing or does not belong to the active run.',
      evidence: staleAttachedEvidence,
    });
  }

  return {
    status: issues.length === 0 ? 'clean' : 'action_required',
    issues,
  };
}

function removeRepoFiles(rootDir: string, relativePaths: string[]): string[] {
  const removed: string[] = [];
  for (const relativePath of relativePaths) {
    const absolutePath = join(rootDir, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    rmSync(absolutePath, { force: true });
    removed.push(relativePath);
  }
  return removed;
}

function removeArtifactIndexEntries(rootDir: string, relativePaths: string[]): void {
  const ledger = readLedger(rootDir);
  if (!ledger) {
    return;
  }

  let changed = false;
  const nextArtifactIndex = { ...ledger.artifact_index };
  for (const relativePath of relativePaths) {
    if (relativePath in nextArtifactIndex) {
      delete nextArtifactIndex[relativePath];
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  writeLedger({
    ...ledger,
    artifact_index: nextArtifactIndex,
  }, rootDir);
}

function upsertArtifactIndexEntries(rootDir: string, relativePaths: string[]): void {
  const ledger = readLedger(rootDir);
  if (!ledger) {
    return;
  }

  let changed = false;
  const nextArtifactIndex = { ...ledger.artifact_index };
  for (const relativePath of relativePaths) {
    const nextPointer = artifactPointerFor(relativePath);
    const currentPointer = nextArtifactIndex[relativePath];
    if (
      !currentPointer
      || currentPointer.kind !== nextPointer.kind
      || currentPointer.path !== nextPointer.path
    ) {
      nextArtifactIndex[relativePath] = nextPointer;
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  writeLedger({
    ...ledger,
    artifact_index: nextArtifactIndex,
  }, rootDir);
}

function dedupeOutputs(outputs: NonNullable<StageStatus['outputs']>): NonNullable<StageStatus['outputs']> {
  const seen = new Set<string>();
  const deduped: NonNullable<StageStatus['outputs']> = [];
  for (const output of outputs) {
    if (seen.has(output.path)) {
      continue;
    }
    seen.add(output.path);
    deduped.push(output);
  }
  return deduped;
}

function repairReviewAdvisoryDrift(rootDir: string): string[] {
  const reviewStatus = readStageStatus(stageStatusPath('review'), rootDir);
  const ledger = readLedger(rootDir);
  if (!hasReviewAdvisoryDrift(rootDir, reviewStatus, ledger?.run_id ?? null)) {
    return [];
  }

  const derived = derivedCurrentReviewAdvisories(rootDir, reviewStatus);
  if (!derived || !reviewStatus) {
    return [];
  }

  const advisoryDisposition = buildReviewAdvisoryDispositionRecord(
    derived.run_id,
    derived.advisories.length,
    null,
    null,
  );
  const outputPaths = [
    reviewAdvisoriesPath(),
    reviewAdvisoryDispositionPath(),
    stageCompletionAdvisorPath('review'),
    stageStatusPath('review'),
  ];
  const repairedStatus: StageStatus = {
    ...reviewStatus,
    outputs: dedupeOutputs([
      ...(reviewStatus.outputs ?? []),
      artifactPointerFor(reviewAdvisoriesPath()),
      artifactPointerFor(reviewAdvisoryDispositionPath()),
      artifactPointerFor(stageCompletionAdvisorPath('review')),
      artifactPointerFor(stageStatusPath('review')),
    ]),
    advisories_path: reviewAdvisoriesPath(),
    advisory_count: derived.advisories.length,
    advisory_categories: derived.categories,
    advisory_disposition: null,
    advisory_disposition_path: reviewAdvisoryDispositionPath(),
  };
  const verificationMatrix = readVerificationMatrix(rootDir);
  const generatedAt = typeof repairedStatus.completed_at === 'string'
    ? repairedStatus.completed_at
    : derived.generated_at;
  const completionAdvisor = buildReviewCompletionAdvisor(repairedStatus, verificationMatrix, generatedAt, []);
  const completionAdvisorWrite = buildCompletionAdvisorWrite(completionAdvisor, {
    cwd: rootDir,
    verificationMatrix,
    externalSkills: [],
  });

  for (const relativePath of outputPaths) {
    mkdirSync(join(rootDir, relativePath, '..'), { recursive: true });
  }
  writeFileSync(join(rootDir, reviewAdvisoriesPath()), JSON.stringify(derived, null, 2) + '\n');
  writeFileSync(join(rootDir, reviewAdvisoryDispositionPath()), JSON.stringify(advisoryDisposition, null, 2) + '\n');
  writeFileSync(join(rootDir, stageStatusPath('review')), JSON.stringify(repairedStatus, null, 2) + '\n');
  writeFileSync(join(rootDir, completionAdvisorWrite.path), completionAdvisorWrite.content);
  upsertArtifactIndexEntries(rootDir, outputPaths);
  return outputPaths;
}

export function applySafeLedgerDoctorFix(rootDir: string): LedgerDoctorSafeFixResult {
  const reportBefore = buildLedgerDoctorReport(rootDir);
  const fixedPaths: string[] = [];
  const fixedIssueCodes: LedgerDoctorIssueCode[] = [];

  if (reportBefore.issues.some((issue) => issue.code === 'stale_current_audits')) {
    const removed = removeRepoFiles(rootDir, currentAuditArtifactsPresent(rootDir));
    if (removed.length > 0) {
      removeArtifactIndexEntries(rootDir, removed);
      fixedPaths.push(...removed);
      fixedIssueCodes.push('stale_current_audits');
    }
  }

  if (reportBefore.issues.some((issue) => issue.code === 'stale_attached_evidence')) {
    const ledger = readLedger(rootDir);
    const qaStatus = readStageStatus(stageStatusPath('qa'), rootDir);
    const shipStatus = readStageStatus(stageStatusPath('ship'), rootDir);
    const closeoutStatus = readStageStatus(stageStatusPath('closeout'), rootDir);
    const removed = removeRepoFiles(rootDir, staleAttachedEvidencePaths({
      rootDir,
      ledgerRunId: ledger?.run_id ?? null,
      qaStatus,
      shipStatus,
      closeoutStatus,
    }));
    if (removed.length > 0) {
      removeArtifactIndexEntries(rootDir, removed);
      fixedPaths.push(...removed);
      fixedIssueCodes.push('stale_attached_evidence');
    }
  }

  if (reportBefore.issues.some((issue) => issue.code === 'review_advisory_drift')) {
    const repaired = repairReviewAdvisoryDrift(rootDir);
    if (repaired.length > 0) {
      fixedPaths.push(...repaired);
      fixedIssueCodes.push('review_advisory_drift');
    }
  }

  return {
    report: buildLedgerDoctorReport(rootDir),
    fixed_paths: [...new Set(fixedPaths)],
    fixed_issue_codes: [...new Set(fixedIssueCodes)],
  };
}
