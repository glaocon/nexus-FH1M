import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  archivedCloseoutRootFor,
  archivedCurrentArtifactPath,
  archivedRunLedgerPath,
  currentAttachedEvidencePaths,
  qaPerfVerificationPath,
  shipCanaryStatusPath,
  shipDeployResultPath,
  closeoutDocumentationSyncPath,
  stageStatusPath,
} from './artifacts';
import { defaultExecutionSelection, type ExecutionSelection } from './execution-topology';
import { readStageStatus } from './status';
import { getAllowedNextStages } from './transitions';
import type {
  CanonicalCommandId,
  ContinuationMode,
  RunLedger,
  SessionRootRecord,
  StageStatus,
  WorkspaceRecord,
} from './types';
import { readJsonFile } from './validation-helpers';

const LEDGER_PATH = '.planning/nexus/current-run.json';

// Convention: canonical gate checks throw in governance.ts; passive artifact
// readers return null so callers can decide whether missing state is allowed.
export function ledgerPath(cwd: string): string {
  return join(cwd, LEDGER_PATH);
}

export function readLedger(cwd: string): RunLedger | null {
  return readJsonFile(ledgerPath(cwd), (value) => value as RunLedger);
}

export function writeLedger(ledger: RunLedger, cwd: string): void {
  mkdirSync(join(cwd, '.planning', 'nexus'), { recursive: true });
  writeFileSync(ledgerPath(cwd), JSON.stringify(ledger, null, 2) + '\n');
}

function closeoutReadyForRollover(status: StageStatus | null, runId: string): boolean {
  return Boolean(
    status
      && status.run_id === runId
      && status.stage === 'closeout'
      && status.state === 'completed'
      && status.ready === true,
  );
}

export function isCompletedCloseoutLedger(ledger: RunLedger, cwd: string): boolean {
  if (ledger.current_stage !== 'closeout' || ledger.status !== 'completed') {
    return false;
  }

  const closeoutStatus = readStageStatus(stageStatusPath('closeout'), cwd);
  return closeoutReadyForRollover(closeoutStatus, ledger.run_id);
}

function shouldArchiveAttachedEvidence(
  currentArtifactPath: string,
  ledgerRunId: string,
  cwd: string,
): boolean {
  const qaStatus = readStageStatus(stageStatusPath('qa'), cwd);
  const shipStatus = readStageStatus(stageStatusPath('ship'), cwd);
  const closeoutStatus = readStageStatus(stageStatusPath('closeout'), cwd);

  if (currentArtifactPath === qaPerfVerificationPath()) {
    return qaStatus?.run_id === ledgerRunId && qaStatus.stage === 'qa';
  }
  if (currentArtifactPath === shipCanaryStatusPath() || currentArtifactPath === shipDeployResultPath()) {
    return shipStatus?.run_id === ledgerRunId && shipStatus.stage === 'ship';
  }
  if (currentArtifactPath === closeoutDocumentationSyncPath()) {
    return closeoutStatus?.run_id === ledgerRunId && closeoutStatus.stage === 'closeout';
  }
  return false;
}

function syncArchivedCurrentArtifact(runId: string, currentArtifactPath: string, cwd: string): void {
  const sourcePath = join(cwd, currentArtifactPath);
  const archivedPath = join(cwd, archivedCurrentArtifactPath(runId, currentArtifactPath));

  if (!shouldArchiveAttachedEvidence(currentArtifactPath, runId, cwd) || !existsSync(sourcePath)) {
    rmSync(archivedPath, { force: true });
    return;
  }

  mkdirSync(dirname(archivedPath), { recursive: true });
  cpSync(sourcePath, archivedPath, { force: true });
}

export function archiveCompletedRunLedger(ledger: RunLedger, cwd: string): void {
  const archivedLedger = join(cwd, archivedRunLedgerPath(ledger.run_id));
  mkdirSync(dirname(archivedLedger), { recursive: true });
  writeFileSync(archivedLedger, JSON.stringify(ledger, null, 2) + '\n');

  const closeoutRoot = join(cwd, '.planning', 'current', 'closeout');
  if (existsSync(closeoutRoot)) {
    const archivedCloseoutRoot = join(cwd, archivedCloseoutRootFor(ledger.run_id));
    rmSync(archivedCloseoutRoot, { recursive: true, force: true });
    cpSync(closeoutRoot, archivedCloseoutRoot, {
      recursive: true,
      force: true,
    });
    const archivedCloseoutStatus = join(archivedCloseoutRoot, 'status.json');
    if (existsSync(archivedCloseoutStatus)) {
      const status = JSON.parse(readFileSync(archivedCloseoutStatus, 'utf8')) as StageStatus;
      writeFileSync(
        archivedCloseoutStatus,
        JSON.stringify(
          {
            ...status,
            workspace: ledger.execution.workspace,
            session_root: ledger.execution.session_root,
          },
          null,
          2,
        ) + '\n',
      );
    }
  }

  for (const evidencePath of currentAttachedEvidencePaths()) {
    syncArchivedCurrentArtifact(ledger.run_id, evidencePath, cwd);
  }
}

export function makeRunId(clock: () => string): string {
  return `run-${clock().replace(/[:.]/g, '-')}`;
}

export function startLedger(
  run_id: string,
  stage: CanonicalCommandId,
  execution: ExecutionSelection = defaultExecutionSelection(),
  options: {
    continuationMode?: ContinuationMode;
    workspace?: WorkspaceRecord;
    sessionRoot?: SessionRootRecord;
  } = {},
): RunLedger {
  return {
    run_id,
    continuation_mode: options.continuationMode ?? 'project_reset',
    status: 'active',
    current_command: stage,
    current_stage: stage,
    previous_stage: null,
    allowed_next_stages: getAllowedNextStages(stage),
    command_history: [],
    artifact_index: {},
    execution: {
      mode: execution.mode,
      primary_provider: execution.primary_provider,
      provider_topology: execution.provider_topology,
      workspace: options.workspace,
      session_root: options.sessionRoot,
      requested_path: execution.requested_execution_path,
      actual_path: null,
    },
    route_intent: {
      planner: null,
      generator: null,
      evaluator_a: null,
      evaluator_b: null,
      synthesizer: null,
      substrate: null,
      fallback_policy: 'disabled',
    },
  };
}
