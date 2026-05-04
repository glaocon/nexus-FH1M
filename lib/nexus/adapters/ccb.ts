import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { spawn } from 'child_process';
import { stageAdapterOutputPath, stageAdapterRequestPath, stageNormalizationPath } from '../artifacts';
import {
  createCcbDispatchId,
  readActiveCcbDispatchState,
  recordCcbAutonewProviderState,
  recordCcbDispatchState,
  recordCcbMountedProviderState,
  recordCcbPingProviderState,
  startCcbDispatchState,
} from '../ccb-runtime-state';
import type { CcbDispatchLatencySummary } from '../ccb-runtime-state';
import type { CcbDispatchRetryProvenance } from '../ccb-runtime-state';
import {
  buildBuildExecutionPrompt,
  buildPromptContextPreamble,
  buildQaValidationPrompt,
  buildReviewAuditPrompt,
  buildReviewFinalizePrompt,
} from './prompt-contracts';
import { createBuildStagePack, createHandoffStagePack, createQaStagePack, createReviewStagePack } from '../stage-packs';
import { resolveRepositoryRoot } from '../workspace-substrate';
import type { ActualRouteRecord, ConflictRecord, LearningCandidate } from '../types';
import type { AdapterResult, AdapterTraceability, CcbAdapter, NexusAdapterContext } from './types';
import {
  buildReviewAuditReceiptRecord,
  persistReviewAuditReceipt,
  readReviewAuditReceipt,
} from '../review-receipts';
import { reviewAttemptAuditMarkdownPath } from '../artifacts';
import { isRecord } from '../validation-helpers';

export interface CcbResolveRouteRaw {
  available: boolean;
  provider: string | null;
  providers?: string[];
  mounted: string[];
  verification_command?: string;
  verification_output?: string;
  verification_commands?: string[];
  provider_checks?: Array<{
    provider: 'codex' | 'gemini';
    ping_command: string;
    ping_output: string;
  }>;
  ping_command?: string;
  ping_output?: string;
  mounted_command?: string;
  mounted_output?: string;
}

export interface CcbExecuteGeneratorRaw {
  receipt: string;
  summary_markdown?: string;
  dispatch_command?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  request_id?: string;
  latency_summary?: CcbDispatchLatencySummary | null;
}

export interface CcbExecuteAuditRaw {
  markdown: string;
  receipt: string;
  learning_candidates?: LearningCandidate[];
  dispatch_command?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  request_id?: string;
  latency_summary?: CcbDispatchLatencySummary | null;
}

export interface CcbExecuteQaRaw {
  report_markdown: string;
  ready: boolean;
  findings: string[];
  advisories?: string[];
  learning_candidates?: LearningCandidate[];
  receipt: string;
  dispatch_command?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  request_id?: string;
  latency_summary?: CcbDispatchLatencySummary | null;
}

export interface CcbToolPaths {
  ask_path: string;
  ping_path: string;
  mounted_path: string;
  autonew_path: string;
  pend_path?: string;
}

export interface CcbCommandSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin_text?: string;
  timeout_ms?: number;
}

export interface CcbCommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

interface CcbDispatchExecution extends CcbCommandResult {
  latency_summary?: CcbDispatchLatencySummary | null;
  request_id?: string | null;
}

export interface CreateRuntimeCcbAdapterOptions {
  resolveToolPaths?: () => CcbToolPaths;
  resolveSessionRoot?: (cwd: string) => string;
  runCommand?: (spec: CcbCommandSpec) => Promise<CcbCommandResult>;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUTS_SECONDS = {
  build: '1800',
  review: '180',
  qa: '900',
} as const;

const LATE_RECOVERY_ATTEMPTS = 5;
const LATE_RECOVERY_POLL_MS = 1_000;
const REVIEW_WATCHDOG_FINALIZE_TIMEOUT_SECONDS = '45';
const REVIEW_WATCHDOG_RECOVERY_ATTEMPTS = 12;
const REVIEW_WATCHDOG_RECOVERY_POLL_MS = 2_000;

interface CcbDispatchRecoveryPolicy {
  post_reset_settle_ms: number;
  foreground_false_start_retry_limit: number;
  late_recovery_attempts: number;
  late_recovery_poll_ms: number;
  review_watchdog_finalize_timeout_seconds: string;
  review_watchdog_recovery_attempts: number;
  review_watchdog_recovery_poll_ms: number;
}

const DEFAULT_DISPATCH_RECOVERY_POLICY: Omit<CcbDispatchRecoveryPolicy, 'post_reset_settle_ms'> = {
  foreground_false_start_retry_limit: 1,
  late_recovery_attempts: LATE_RECOVERY_ATTEMPTS,
  late_recovery_poll_ms: LATE_RECOVERY_POLL_MS,
  review_watchdog_finalize_timeout_seconds: REVIEW_WATCHDOG_FINALIZE_TIMEOUT_SECONDS,
  review_watchdog_recovery_attempts: REVIEW_WATCHDOG_RECOVERY_ATTEMPTS,
  review_watchdog_recovery_poll_ms: REVIEW_WATCHDOG_RECOVERY_POLL_MS,
};

const PROVIDER_DISPATCH_RECOVERY_POLICY: Record<'codex' | 'gemini', CcbDispatchRecoveryPolicy> = {
  codex: {
    post_reset_settle_ms: 250,
    ...DEFAULT_DISPATCH_RECOVERY_POLICY,
  },
  gemini: {
    post_reset_settle_ms: 500,
    ...DEFAULT_DISPATCH_RECOVERY_POLICY,
  },
};

function successResult<TRaw>(
  raw_output: TRaw,
  actual_route: ActualRouteRecord | null,
  requested_route: AdapterResult<TRaw>['requested_route'],
  traceability: AdapterTraceability,
): AdapterResult<TRaw> {
  return {
    adapter_id: 'ccb',
    outcome: 'success',
    raw_output,
    requested_route,
    actual_route,
    notices: [],
    conflict_candidates: [],
    traceability,
  };
}

function blockedResult<TRaw>(
  stage: NexusAdapterContext['stage'],
  message: string,
  raw_output: TRaw,
  requested_route: AdapterResult<TRaw>['requested_route'],
  traceability: AdapterTraceability,
): AdapterResult<TRaw> {
  return {
    adapter_id: 'ccb',
    outcome: 'blocked',
    raw_output,
    requested_route,
    actual_route: null,
    notices: [message],
    conflict_candidates: [backendConflict(stage, message)],
    traceability,
  };
}

function backendConflict(stage: NexusAdapterContext['stage'], message: string): ConflictRecord {
  return {
    stage,
    adapter: 'ccb',
    kind: 'backend_conflict',
    message,
    canonical_paths: [],
    trace_paths: [
      stageAdapterRequestPath(stage),
      stageAdapterOutputPath(stage),
      stageNormalizationPath(stage),
    ],
  };
}

function inactiveResult(): AdapterResult<null> {
  return {
    adapter_id: 'ccb',
    outcome: 'blocked',
    raw_output: null,
    requested_route: null,
    actual_route: null,
    notices: ['CCB audit seam is reserved for a later milestone'],
    conflict_candidates: [],
  };
}

function expectedProvider(generator: string | null): 'codex' | 'gemini' | null {
  if (generator?.startsWith('codex')) {
    return 'codex';
  }

  if (generator?.startsWith('gemini')) {
    return 'gemini';
  }

  return null;
}

function expectedProvidersFromRequestedRoute(
  requestedRoute: NexusAdapterContext['requested_route'],
): Array<'codex' | 'gemini'> {
  if (!requestedRoute) {
    return [];
  }

  const providers = [
    expectedProvider(requestedRoute.generator ?? null),
    expectedProvider(requestedRoute.evaluator_a ?? null),
    expectedProvider(requestedRoute.evaluator_b ?? null),
  ].filter((provider): provider is 'codex' | 'gemini' => provider !== null);

  return [...new Set(providers)];
}

function sanitizeReceiptTimestamp(value: string): string {
  return value.replace(/:/g, '-');
}

function defaultResolveToolPaths(): CcbToolPaths {
  const installBin = join(homedir(), '.local', 'share', 'codex-dual', 'bin');
  const askPath = join(installBin, 'ask');
  const pingPath = join(installBin, 'ccb-ping');
  const mountedPath = join(installBin, 'ccb-mounted');
  const autonewPath = join(installBin, 'autonew');
  const pendPath = join(installBin, 'pend');

  return {
    ask_path: existsSync(askPath) ? askPath : 'ask',
    ping_path: existsSync(pingPath) ? pingPath : 'ccb-ping',
    mounted_path: existsSync(mountedPath) ? mountedPath : 'ccb-mounted',
    autonew_path: existsSync(autonewPath) ? autonewPath : 'autonew',
    pend_path: existsSync(pendPath) ? pendPath : 'pend',
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function defaultResolveSessionRoot(cwd: string): string {
  let current = resolve(cwd);

  while (true) {
    if (existsSync(join(current, '.ccb')) || existsSync(join(current, '.ccb_config'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(cwd);
    }

    current = parent;
  }
}

function sessionFileForProvider(root: string, provider: 'codex' | 'gemini' | 'claude'): string | null {
  const primary = join(root, '.ccb', `.${provider}-session`);
  if (existsSync(primary)) {
    return primary;
  }

  const legacy = join(root, '.ccb_config', `.${provider}-session`);
  if (existsSync(legacy)) {
    return legacy;
  }

  return primary;
}

function defaultRunCommand(spec: CcbCommandSpec): Promise<CcbCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: {
        ...process.env,
        ...spec.env,
        PWD: spec.cwd,
      },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finalize = (result: CcbCommandResult) => {
      if (settled) {
        return;
      }

      settled = true;
      resolvePromise(result);
    };

    let timeoutHandle: Timer | null = null;
    if (spec.timeout_ms && spec.timeout_ms > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGKILL');
        finalize({
          exit_code: 124,
          stdout,
          stderr: `${stderr}${stderr ? '\n' : ''}[TIMEOUT] command exceeded ${spec.timeout_ms}ms`,
        });
      }, spec.timeout_ms);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (!settled) {
        reject(error);
      }
    });
    child.on('close', (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      finalize({
        exit_code: code ?? 1,
        stdout,
        stderr,
      });
    });

    if (spec.stdin_text) {
      child.stdin.write(spec.stdin_text);
    }
    child.stdin.end();
  });
}

function envForCwd(cwd: string, env: Record<string, string> = {}): Record<string, string> {
  return {
    ...env,
    PWD: cwd,
  };
}

function describeCommand(argv: string[]): string {
  return argv.join(' ');
}

function buildActualRoute(
  provider: 'codex' | 'gemini' | null,
  route: string | null,
  substrate: string | null,
  stage: 'handoff' | 'build' | 'review' | 'qa',
): ActualRouteRecord {
  return {
    provider,
    route,
    substrate,
    transport: 'ccb',
    receipt_path: stageAdapterOutputPath(stage),
  };
}

function executionWorkspacePath(ctx: NexusAdapterContext): string {
  return ctx.ledger.execution.workspace?.path ?? ctx.workspace?.path ?? ctx.cwd;
}

function sessionRootPath(
  ctx: NexusAdapterContext,
  options: Required<CreateRuntimeCcbAdapterOptions>,
): string {
  return ctx.ledger.execution.session_root?.path ?? options.resolveSessionRoot(ctx.cwd);
}

function normalizedExecutionContext(ctx: NexusAdapterContext): NexusAdapterContext {
  return {
    ...ctx,
    workspace: ctx.ledger.execution.workspace ?? ctx.workspace,
  };
}

function auditHeaderForProvider(provider: 'codex' | 'gemini'): string {
  return provider === 'codex' ? '# Codex Audit' : '# Gemini Audit';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCanonicalReviewAuditMarkdown(
  text: string,
  provider: 'codex' | 'gemini',
): string | null {
  const trimmed = text.trim();
  const header = auditHeaderForProvider(provider);
  const headerIndex = trimmed.lastIndexOf(header);

  if (headerIndex === -1) {
    return null;
  }

  const candidate = trimmed.slice(headerIndex).trim();
  const headerPattern = new RegExp(`^${escapeRegExp(header)}\\s*$`, 'm');

  if (!headerPattern.test(candidate)) {
    return null;
  }

  if (!/^\s*Result:\s*(pass|fail)\s*$/mi.test(candidate)) {
    return null;
  }

  if (!/^Findings:\s*$/mi.test(candidate)) {
    return null;
  }

  return candidate;
}

function canonicalReviewAuditVerdict(markdown: string): 'pass' | 'fail' {
  const matches = [...markdown.matchAll(/Result:\s*(pass|fail)/gi)];
  const verdict = matches.at(-1)?.[1]?.toLowerCase();
  if (verdict !== 'pass' && verdict !== 'fail') {
    throw new Error('Malformed review response: canonical audit block is missing Result: pass|fail');
  }

  return verdict;
}

function buildGeneratorPrompt(ctx: NexusAdapterContext): string {
  return buildBuildExecutionPrompt(normalizedExecutionContext(ctx), 'Nexus governed stage');
}

function buildAuditPrompt(
  ctx: NexusAdapterContext,
  provider: 'codex' | 'gemini',
): string {
  const header = auditHeaderForProvider(provider);

  return buildReviewAuditPrompt(
    normalizedExecutionContext(ctx),
    'Nexus governed stage',
    `Perform the governed Nexus /review audit for the ${provider} path.`,
    header,
  );
}

function reviewRequestedRouteFromContext(
  ctx: NexusAdapterContext,
  provider: 'codex' | 'gemini',
) {
  return {
    provider,
    route: provider === 'codex'
      ? (ctx.requested_route?.evaluator_a ?? 'codex-via-ccb')
      : (ctx.requested_route?.evaluator_b ?? 'gemini-via-ccb'),
    substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
    transport: 'ccb' as const,
  };
}

function reviewReceiptMatchesContext(
  ctx: NexusAdapterContext,
  provider: 'codex' | 'gemini',
): { markdown: string; requestId: string | null } | null {
  if (ctx.stage !== 'review' || !ctx.review_attempt_id) {
    return null;
  }

  const receipt = readReviewAuditReceipt({
    cwd: ctx.cwd,
    review_attempt_id: ctx.review_attempt_id,
    provider,
  });
  if (!receipt) {
    return null;
  }

  const expectedRoute = reviewRequestedRouteFromContext(ctx, provider);
  if (
    receipt.record.review_attempt_id !== ctx.review_attempt_id
    || receipt.record.provider !== provider
    || receipt.record.requested_route.provider !== expectedRoute.provider
    || receipt.record.requested_route.route !== expectedRoute.route
    || receipt.record.requested_route.substrate !== expectedRoute.substrate
    || receipt.record.requested_route.transport !== expectedRoute.transport
  ) {
    return null;
  }

  const markdown = extractCanonicalReviewAuditMarkdown(receipt.markdown, provider);
  if (markdown === null) {
    return null;
  }

  return {
    markdown,
    requestId: receipt.record.request_id,
  };
}

function buildAuditFinalizePrompt(
  ctx: NexusAdapterContext,
  provider: 'codex' | 'gemini',
): string {
  const header = auditHeaderForProvider(provider);
  return buildReviewFinalizePrompt(normalizedExecutionContext(ctx), 'Nexus governed stage', provider, header);
}

function buildQaPrompt(ctx: NexusAdapterContext): string {
  return buildQaValidationPrompt(
    normalizedExecutionContext(ctx),
    'Nexus governed stage',
    'Perform the governed Nexus /qa validation for this repository.',
    [
      'Required JSON schema:',
      'Set ready=false and include findings when defects remain.',
      'Use advisories only for non-blocking concerns; advisories alone must not make ready=false.',
      'report_markdown must begin with "# QA Report" and include a "Result:" line.',
    ],
  );
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  const lines = trimmed.split('\n');
  if (lines.length < 3) {
    return trimmed;
  }

  return lines.slice(1, -1).join('\n').trim();
}

function extractJsonObject(text: string): string {
  const normalized = stripMarkdownFences(text);
  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Malformed QA response: no JSON object found');
  }

  return normalized.slice(firstBrace, lastBrace + 1);
}

function parseQaPayload(stdout: string): Omit<CcbExecuteQaRaw, 'receipt' | 'dispatch_command'> {
  const normalized = extractJsonObject(stdout);
  let parsed: {
    ready?: unknown;
    findings?: unknown;
    advisories?: unknown;
    report_markdown?: unknown;
    learning_candidates?: unknown;
  };

  try {
    parsed = JSON.parse(normalized) as {
      ready?: unknown;
      findings?: unknown;
      advisories?: unknown;
      report_markdown?: unknown;
      learning_candidates?: unknown;
    };
  } catch (error) {
    throw new Error(`Malformed QA response: ${error instanceof Error ? error.message : String(error)}`);
  }
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.filter((value): value is string => typeof value === 'string')
    : null;

  if (typeof parsed.ready !== 'boolean' || typeof parsed.report_markdown !== 'string' || findings === null) {
    throw new Error('Malformed QA response: expected JSON with ready, findings, and report_markdown');
  }

  const advisories = typeof parsed.advisories === 'undefined'
    ? undefined
    : Array.isArray(parsed.advisories)
      ? parsed.advisories.filter((value): value is string => typeof value === 'string')
      : null;

  if (advisories === null) {
    throw new Error('Malformed QA response: advisories must be an array when present');
  }

  const learningCandidates = normalizeOptionalQaLearningCandidates(parsed.learning_candidates);

  return {
    ready: parsed.ready,
    findings,
    ...(typeof advisories !== 'undefined' ? { advisories } : {}),
    report_markdown: parsed.report_markdown.trim(),
    ...(typeof learningCandidates !== 'undefined'
      ? { learning_candidates: learningCandidates }
      : {}),
  };
}

function normalizeOptionalQaLearningCandidates(rawCandidates: unknown): LearningCandidate[] | undefined {
  if (typeof rawCandidates === 'undefined') {
    return undefined;
  }

  if (!Array.isArray(rawCandidates)) {
    return undefined;
  }

  const candidates: LearningCandidate[] = [];
  for (const candidate of rawCandidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }

    const rawCandidate = candidate as Partial<LearningCandidate> & { files?: unknown };
    if (
      typeof rawCandidate.type !== 'string'
      || typeof rawCandidate.key !== 'string'
      || typeof rawCandidate.insight !== 'string'
      || typeof rawCandidate.confidence !== 'number'
      || typeof rawCandidate.source !== 'string'
      || !Array.isArray(rawCandidate.files)
    ) {
      continue;
    }

    const files = rawCandidate.files
      .filter((file): file is string => typeof file === 'string')
      .map((file) => file.trim())
      .filter(Boolean);

    if (!rawCandidate.key.trim() || !rawCandidate.insight.trim()) {
      continue;
    }

    candidates.push({
      type: rawCandidate.type,
      key: rawCandidate.key.trim(),
      insight: rawCandidate.insight.trim(),
      confidence: rawCandidate.confidence,
      source: rawCandidate.source,
      files,
    });
  }

  return candidates;
}

function summarizeCommandOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').trim();
}

function extractRequestId(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const match = combined.match(/CCB_REQ_ID:\s*([^\s]+)/);

  return match?.[1] ?? null;
}

function recoverableAskPayload(
  stage: 'handoff' | 'build' | 'review' | 'qa',
  stdout: string,
  stderr: string,
  provider?: 'codex' | 'gemini',
): string | null {
  const candidates = [stdout.trim(), stderr.trim()].filter(Boolean);

  for (const candidate of candidates) {
    if (stage === 'build') {
      if (/^# Build Execution Summary\b/m.test(candidate) && /^- Status:\s*(completed|blocked)\s*$/mi.test(candidate)) {
        return candidate;
      }
      continue;
    }

    if (stage === 'review') {
      const providers = provider ? [provider] : ['codex', 'gemini'] as const;
      for (const candidateProvider of providers) {
        const extracted = extractCanonicalReviewAuditMarkdown(candidate, candidateProvider);
        if (extracted !== null) {
          return extracted;
        }
      }
      continue;
    }

    if (stage === 'qa') {
      try {
        parseQaPayload(candidate);
        return candidate;
      } catch {
        // keep checking
      }
    }
  }

  return null;
}

function shouldAttemptAnonymousLateRecovery(
  stage: 'handoff' | 'build' | 'review' | 'qa',
  stdout: string,
  stderr: string,
): boolean {
  if (stage === 'handoff') {
    return false;
  }

  if (recoverableAskPayload(stage, stdout, stderr) !== null) {
    return false;
  }

  const trimmedStdout = stdout.trim();
  if (!trimmedStdout || !/[A-Za-z]/.test(trimmedStdout)) {
    return false;
  }

  const combined = `${trimmedStdout}\n${stderr.trim()}`;
  if (/CCB_REQ_ID:\s*[^\s]+/.test(combined)) {
    return false;
  }

  if (/\[ERROR\]|Unknown provider|not running|No (?:Gemini |Codex )?reply available|command exceeded/i.test(combined)) {
    return false;
  }

  return true;
}

function parseMountedProviders(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`Malformed ccb-mounted output: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.mounted) || !parsed.mounted.every((entry) => typeof entry === 'string')) {
    throw new Error('Malformed ccb-mounted output: expected a JSON object with a string[] mounted field');
  }

  return parsed.mounted;
}

function shouldAttemptReviewWatchdog(
  provider: 'codex' | 'gemini',
  stdout: string,
  stderr: string,
): boolean {
  if (recoverableAskPayload('review', stdout, stderr, provider) !== null) {
    return false;
  }

  const combined = `${stdout.trim()}\n${stderr.trim()}`.trim();
  if (/\[ERROR\]|Unknown provider|not running|No (?:Gemini |Codex )?reply available/i.test(combined)) {
    return false;
  }

  // A silent nonzero foreground exit can still leave the provider working in-pane.
  // Treat it as a watchdog candidate so we nudge finalization and attempt pend recovery
  // before collapsing the governed review into a blocked state.
  if (!combined) {
    return true;
  }

  if (/\[TIMEOUT\]|foreground wait ended before provider reply was surfaced|command exceeded/i.test(combined)) {
    return true;
  }

  return shouldAttemptAnonymousLateRecovery('review', stdout, stderr) || /CCB_REQ_ID:\s*[^\s]+/.test(combined);
}

function shouldAttemptForegroundFalseStartRetry(input: {
  stage: 'handoff' | 'build' | 'review' | 'qa';
  stdout: string;
  stderr: string;
  requestId: string | null;
  sessionResetBeforeDispatch: boolean;
  retryLimit: number;
}): boolean {
  if (!input.sessionResetBeforeDispatch) {
    return false;
  }

  if (input.retryLimit <= 0) {
    return false;
  }

  if (input.stage !== 'review' && input.stage !== 'qa') {
    return false;
  }

  if (input.requestId) {
    return false;
  }

  return shouldAttemptAnonymousLateRecovery(input.stage, input.stdout, input.stderr);
}

function dispatchRecoveryPolicy(provider: 'codex' | 'gemini'): CcbDispatchRecoveryPolicy {
  return PROVIDER_DISPATCH_RECOVERY_POLICY[provider];
}

function excerptTransportOutput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= 240) {
    return trimmed;
  }

  return `${trimmed.slice(0, 237)}...`;
}

function buildForegroundRetryProvenance(input: {
  execution: CcbCommandResult;
  requestId: string | null;
  retryCount: number;
}): CcbDispatchRetryProvenance {
  return {
    reason: 'foreground_false_start',
    retry_count: input.retryCount,
    initial_exit_code: input.execution.exit_code,
    initial_request_id: input.requestId,
    initial_stdout_excerpt: excerptTransportOutput(input.execution.stdout),
    initial_stderr_excerpt: excerptTransportOutput(input.execution.stderr),
  };
}

function markSupersededActiveDispatch(input: {
  repoRoot: string;
  provider: 'codex' | 'gemini';
  updatedAt: string;
}): void {
  const activeDispatch = readActiveCcbDispatchState(input.repoRoot, input.provider, input.updatedAt);
  if (activeDispatch?.status !== 'dispatched') {
    return;
  }

  recordCcbDispatchState({
    repoRoot: input.repoRoot,
    dispatchId: activeDispatch.dispatch_id,
    requestId: activeDispatch.request_id,
    provider: activeDispatch.provider,
    stage: activeDispatch.stage,
    status: 'superseded',
    payloadSource: activeDispatch.payload_source,
    sessionRoot: activeDispatch.session_root,
    sessionFile: activeDispatch.session_file,
    executionWorkspace: activeDispatch.execution_workspace,
    dispatchCommand: activeDispatch.dispatch_command,
    dispatchedAt: activeDispatch.dispatched_at,
    updatedAt: input.updatedAt,
    askExitCode: activeDispatch.ask_exit_code,
    stdout: activeDispatch.stdout,
    stderr: [activeDispatch.stderr, '[SUPERSEDED] replaced by a newer governed dispatch before completion']
      .filter(Boolean)
      .join('\n'),
    retryProvenance: activeDispatch.retry_provenance,
    latencySummary: activeDispatch.latency_summary,
  });
}

function foregroundExitKind(exitCode: number, stdout: string, stderr: string): CcbDispatchLatencySummary['foreground_exit'] {
  if (exitCode === 124 || /\[TIMEOUT\]|command exceeded/i.test(`${stdout}\n${stderr}`)) {
    return 'timeout';
  }

  if (exitCode === 0) {
    return 'success';
  }

  return 'nonzero';
}

function buildDispatchLatencySummary(input: {
  stage: 'handoff' | 'build' | 'review' | 'qa';
  exitCode: number;
  stdout: string;
  stderr: string;
  watchdogEngaged: boolean;
  finalizeNudgeIssued: boolean;
  foregroundRetryCount: number;
  pendAttempts: number;
  recoveredVia: 'ask' | 'pend' | 'receipt' | null;
}): CcbDispatchLatencySummary {
  const foregroundExit = foregroundExitKind(input.exitCode, input.stdout, input.stderr);
  let path: CcbDispatchLatencySummary['path'] = 'blocked';
  let likelyCause: CcbDispatchLatencySummary['likely_cause'] = 'dispatch_failed';

  if (foregroundExit === 'success' && input.foregroundRetryCount > 0 && !input.watchdogEngaged && input.pendAttempts === 0) {
    path = 'foreground_retry';
    likelyCause = 'orchestration_false_start';
  } else if (foregroundExit === 'success' && !input.watchdogEngaged && input.pendAttempts === 0) {
    path = 'foreground';
    likelyCause = 'normal';
  } else if (input.watchdogEngaged) {
    path = 'watchdog_recovery';
    likelyCause = foregroundExit === 'timeout' ? 'provider_slow' : 'orchestration_false_start';
  } else if (input.pendAttempts > 0 || input.recoveredVia !== null) {
    path = 'late_recovery';
    likelyCause = 'orchestration_false_start';
  } else if (input.foregroundRetryCount > 0) {
    likelyCause = 'orchestration_false_start';
  }

  return {
    path,
    likely_cause: likelyCause,
    foreground_exit: foregroundExit,
    foreground_retry_count: input.foregroundRetryCount,
    finalize_nudge_issued: input.finalizeNudgeIssued,
    pend_attempts: input.pendAttempts,
    recovered_via: input.recoveredVia,
  };
}

async function runRouteVerification(
  ctx: NexusAdapterContext,
  traceability: AdapterTraceability,
  options: Required<CreateRuntimeCcbAdapterOptions>,
): Promise<AdapterResult<CcbResolveRouteRaw>> {
  const repoRoot = resolveRepositoryRoot(ctx.cwd);
  const provider = expectedProvider(ctx.requested_route?.generator ?? null);
  const providers = expectedProvidersFromRequestedRoute(ctx.requested_route);
  if (!ctx.requested_route || !provider || providers.length === 0) {
    return blockedResult(
      ctx.stage,
      'Nexus requested route is missing a supported CCB provider',
      {
        available: false,
        provider,
        providers,
        mounted: [],
      },
      ctx.requested_route,
      traceability,
    );
  }

  const toolPaths = options.resolveToolPaths();
  const verificationCwd = sessionRootPath(ctx, options);
  const verificationAt = options.now();
  const mountedArgv = [toolPaths.mounted_path, '--autostart'];
  const verificationCommands = [
    describeCommand(mountedArgv),
    ...providers.map((candidate) => describeCommand([toolPaths.ping_path, candidate])),
  ];
  const providerChecks: NonNullable<CcbResolveRouteRaw['provider_checks']> = [];

  let mountedExecution: CcbCommandResult;
  try {
    mountedExecution = await options.runCommand({
      argv: mountedArgv,
      cwd: verificationCwd,
      env: envForCwd(verificationCwd),
      timeout_ms: 40_000,
    });
  } catch (error) {
    for (const candidate of providers) {
      recordCcbMountedProviderState({
        repoRoot,
        provider: candidate,
        sessionRoot: verificationCwd,
        sessionFile: sessionFileForProvider(verificationCwd, candidate),
        mounted: false,
        mountedOutput: error instanceof Error ? error.message : String(error),
        now: verificationAt,
      });
    }
    return blockedResult(
      ctx.stage,
      error instanceof Error ? error.message : String(error),
      {
        available: false,
        provider,
        providers,
        mounted: [],
        verification_commands: verificationCommands,
        provider_checks: providerChecks,
        mounted_command: describeCommand(mountedArgv),
      },
      ctx.requested_route,
      traceability,
    );
  }

  const mountedOutput = summarizeCommandOutput(mountedExecution.stdout, mountedExecution.stderr);
  if (mountedExecution.exit_code !== 0) {
    for (const candidate of providers) {
      recordCcbMountedProviderState({
        repoRoot,
        provider: candidate,
        sessionRoot: verificationCwd,
        sessionFile: sessionFileForProvider(verificationCwd, candidate),
        mounted: false,
        mountedOutput,
        now: verificationAt,
      });
    }
    return blockedResult(
      ctx.stage,
      mountedOutput || 'CCB mounted provider discovery failed',
      {
        available: false,
        provider,
        providers,
        mounted: [],
        verification_commands: verificationCommands,
        provider_checks: providerChecks,
        mounted_command: describeCommand(mountedArgv),
        mounted_output: mountedOutput,
      },
      ctx.requested_route,
      traceability,
    );
  }

  let mountedProviders: string[];
  try {
    mountedProviders = parseMountedProviders(mountedExecution.stdout);
  } catch (error) {
    for (const candidate of providers) {
      recordCcbMountedProviderState({
        repoRoot,
        provider: candidate,
        sessionRoot: verificationCwd,
        sessionFile: sessionFileForProvider(verificationCwd, candidate),
        mounted: false,
        mountedOutput: error instanceof Error ? error.message : String(error),
        now: verificationAt,
      });
    }
    return blockedResult(
      ctx.stage,
      error instanceof Error ? error.message : String(error),
      {
        available: false,
        provider,
        providers,
        mounted: [],
        verification_commands: verificationCommands,
        mounted_command: describeCommand(mountedArgv),
        mounted_output: mountedOutput,
      },
      ctx.requested_route,
      traceability,
    );
  }

  for (const candidate of providers) {
    recordCcbMountedProviderState({
      repoRoot,
      provider: candidate,
      sessionRoot: verificationCwd,
      sessionFile: sessionFileForProvider(verificationCwd, candidate),
      mounted: mountedProviders.includes(candidate),
      mountedOutput,
      now: verificationAt,
    });
  }

  for (const candidate of providers) {
    const pingArgv = [toolPaths.ping_path, candidate];
    let pingExecution: CcbCommandResult;
    try {
      pingExecution = await options.runCommand({
        argv: pingArgv,
        cwd: verificationCwd,
        env: envForCwd(verificationCwd),
        timeout_ms: 40_000,
      });
    } catch (error) {
      recordCcbPingProviderState({
        repoRoot,
        provider: candidate,
        sessionRoot: verificationCwd,
        sessionFile: sessionFileForProvider(verificationCwd, candidate),
        pingOk: false,
        pingOutput: error instanceof Error ? error.message : String(error),
        now: options.now(),
      });
      return blockedResult(
        ctx.stage,
        error instanceof Error ? error.message : String(error),
        {
          available: false,
          provider,
          providers,
          mounted: mountedProviders,
          verification_commands: verificationCommands,
          ping_command: describeCommand(pingArgv),
          mounted_command: describeCommand(mountedArgv),
          mounted_output: mountedOutput,
        },
        ctx.requested_route,
        traceability,
      );
    }

    const pingOutput = summarizeCommandOutput(pingExecution.stdout, pingExecution.stderr);
    recordCcbPingProviderState({
      repoRoot,
      provider: candidate,
      sessionRoot: verificationCwd,
      sessionFile: sessionFileForProvider(verificationCwd, candidate),
      pingOk: pingExecution.exit_code === 0,
      pingOutput,
      now: options.now(),
    });
    if (pingExecution.exit_code !== 0) {
      return blockedResult(
        ctx.stage,
        pingOutput || `CCB ${candidate} route check failed`,
        {
          available: false,
          provider,
          providers,
          mounted: mountedProviders,
          verification_commands: verificationCommands,
          provider_checks,
          ping_command: describeCommand(pingArgv),
          ping_output: pingOutput,
          mounted_command: describeCommand(mountedArgv),
          mounted_output: mountedOutput,
        },
        ctx.requested_route,
        traceability,
      );
    }

    providerChecks.push({
      provider: candidate,
      ping_command: describeCommand(pingArgv),
      ping_output: pingOutput,
    });
  }

  const missingProviders = providers.filter((candidate) => !mountedProviders.includes(candidate));
  if (missingProviders.length > 0) {
    return blockedResult(
      ctx.stage,
      `CCB mounted providers do not include ${missingProviders.join(', ')}`,
      {
        available: false,
        provider,
        providers,
        mounted: mountedProviders,
        verification_commands: verificationCommands,
        provider_checks: providerChecks,
        mounted_command: describeCommand(mountedArgv),
        mounted_output: mountedOutput,
        verification_command: describeCommand(mountedArgv),
        verification_output: mountedOutput,
      },
      ctx.requested_route,
      traceability,
    );
  }

  return successResult<CcbResolveRouteRaw>(
    {
      available: true,
      provider,
      providers,
      mounted: mountedProviders,
      verification_command: describeCommand(mountedArgv),
      verification_output: [mountedOutput, ...providerChecks.map((check) => check.ping_output)].filter(Boolean).join('\n'),
      verification_commands: verificationCommands,
      provider_checks: providerChecks,
      ping_command: providerChecks[0]?.ping_command,
      ping_output: providerChecks[0]?.ping_output,
      mounted_command: describeCommand(mountedArgv),
      mounted_output: mountedOutput,
    },
    buildActualRoute(provider, ctx.requested_route.generator, ctx.requested_route.substrate, 'handoff'),
    ctx.requested_route,
    traceability,
  );
}

async function runAskDispatch(
  ctx: NexusAdapterContext,
  provider: 'codex' | 'gemini',
  stage: 'handoff' | 'build' | 'review' | 'qa',
  prompt: string,
  traceability: AdapterTraceability,
  options: Required<CreateRuntimeCcbAdapterOptions>,
  sessionResetBeforeDispatch = false,
): Promise<CcbDispatchExecution | AdapterResult<any>> {
  const toolPaths = options.resolveToolPaths();
  const executionCwd = executionWorkspacePath(ctx);
  const repoRoot = resolveRepositoryRoot(ctx.cwd);
  const sessionRoot = sessionRootPath(ctx, options);
  const sessionFile = sessionFileForProvider(sessionRoot, provider);
  const recoveryPolicy = dispatchRecoveryPolicy(provider);
  const dispatchAt = options.now();
  const dispatchId = stage === 'handoff'
    ? null
    : createCcbDispatchId({
      provider,
      stage,
      at: dispatchAt,
    });

  const argv = [
    toolPaths.ask_path,
    provider,
    '--foreground',
    '--no-wrap',
    '--timeout',
    stage === 'handoff' ? '30' : DEFAULT_TIMEOUTS_SECONDS[stage],
  ];
  const dispatchCommand = describeCommand(argv);

  if (dispatchId && stage !== 'handoff') {
    markSupersededActiveDispatch({
      repoRoot,
      provider,
      updatedAt: dispatchAt,
    });

    startCcbDispatchState({
      repoRoot,
      dispatchId,
      provider,
      stage,
      sessionRoot,
      sessionFile,
      executionWorkspace: executionCwd,
      dispatchCommand,
      dispatchedAt: dispatchAt,
    });
  }

  let execution: CcbCommandResult;
  const runForegroundAsk = () => options.runCommand({
    argv,
    cwd: executionCwd,
    env: envForCwd(executionCwd, {
      CCB_CALLER: 'claude',
      CCB_ASKD_AUTOSTART: '1',
      CCB_ALLOW_FOREGROUND: '1',
      CCB_SESSION_FILE: sessionFile,
    }),
    stdin_text: prompt,
    timeout_ms: Number(stage === 'handoff' ? '30' : DEFAULT_TIMEOUTS_SECONDS[stage]) * 1000 + 10_000,
  });
  try {
    execution = await runForegroundAsk();
  } catch (error) {
    return blockedResult(
      ctx.stage,
      error instanceof Error ? error.message : String(error),
      {
        receipt: '',
        dispatch_command: dispatchCommand,
      },
      ctx.requested_route,
      traceability,
    );
  }

  let foregroundRetryCount = 0;
  let retryProvenance: CcbDispatchRetryProvenance | null = null;
  if (execution.exit_code !== 0) {
    let requestId = extractRequestId(execution.stdout, execution.stderr);
    let watchdogEngaged = false;
    let finalizeNudgeIssued = false;
    let pendAttempts = 0;
    const recoveredPayload = recoverableAskPayload(stage, execution.stdout, execution.stderr, provider);
    if (recoveredPayload !== null) {
      const latencySummary = buildDispatchLatencySummary({
        stage,
        exitCode: execution.exit_code,
        stdout: execution.stdout,
        stderr: execution.stderr,
        watchdogEngaged,
        finalizeNudgeIssued,
        foregroundRetryCount,
        pendAttempts,
        recoveredVia: 'ask',
      });
      if (dispatchId && stage !== 'handoff') {
        recordCcbDispatchState({
          repoRoot,
          dispatchId,
          requestId,
          provider,
          stage,
          status: 'completed',
          payloadSource: 'ask',
          sessionRoot,
          sessionFile,
          executionWorkspace: executionCwd,
          dispatchCommand,
          dispatchedAt: dispatchAt,
          updatedAt: options.now(),
          askExitCode: execution.exit_code,
          stdout: recoveredPayload,
          stderr: execution.stderr,
          latencySummary,
        });
      }
      return {
        ...execution,
        stdout: recoveredPayload,
        request_id: requestId,
        latency_summary: latencySummary,
      };
    }

    if (shouldAttemptForegroundFalseStartRetry({
      stage,
      stdout: execution.stdout,
      stderr: execution.stderr,
      requestId,
      sessionResetBeforeDispatch,
      retryLimit: recoveryPolicy.foreground_false_start_retry_limit,
    })) {
      const retryReset = await resetProviderSession(ctx, provider, traceability, options);
      if (retryReset) {
        return retryReset;
      }

      foregroundRetryCount = 1;
      retryProvenance = buildForegroundRetryProvenance({
        execution,
        requestId,
        retryCount: foregroundRetryCount,
      });
      try {
        const retryExecution = await runForegroundAsk();
        execution = {
          ...retryExecution,
          stderr: [
            '[TRANSPORT] initial foreground ask false-started after session reset; retried once',
            retryExecution.stderr.trim(),
          ].filter(Boolean).join('\n'),
        };
        requestId = extractRequestId(execution.stdout, execution.stderr);
      } catch (error) {
        return blockedResult(
          ctx.stage,
          error instanceof Error ? error.message : String(error),
          {
            receipt: '',
            dispatch_command: dispatchCommand,
          },
          ctx.requested_route,
          traceability,
        );
      }

      const retryRecoveredPayload = recoverableAskPayload(stage, execution.stdout, execution.stderr, provider);
      if (retryRecoveredPayload !== null) {
        const latencySummary = buildDispatchLatencySummary({
          stage,
          exitCode: execution.exit_code,
          stdout: execution.stdout,
          stderr: execution.stderr,
          watchdogEngaged,
          finalizeNudgeIssued,
          foregroundRetryCount,
          pendAttempts,
          recoveredVia: 'ask',
        });
        if (dispatchId && stage !== 'handoff') {
          recordCcbDispatchState({
            repoRoot,
            dispatchId,
            requestId,
            provider,
            stage,
            status: 'completed',
            payloadSource: 'ask',
            sessionRoot,
            sessionFile,
            executionWorkspace: executionCwd,
            dispatchCommand,
            dispatchedAt: dispatchAt,
            updatedAt: options.now(),
            askExitCode: execution.exit_code,
            stdout: retryRecoveredPayload,
            stderr: execution.stderr,
            retryProvenance,
            latencySummary,
          });
        }
        return {
          ...execution,
          stdout: retryRecoveredPayload,
          request_id: requestId,
          latency_summary: latencySummary,
        };
      }
    }

    let recoveryPayload: string | null = null;
    let recoveryPayloadSource: 'ask' | 'pend' | null = null;
    let recoveryStderr = execution.stderr;

    if (stage === 'review' && shouldAttemptReviewWatchdog(provider, execution.stdout, execution.stderr)) {
      watchdogEngaged = true;
      const nudgeExecution = await runReviewFinalizeNudge(
        ctx,
        provider,
        sessionRoot,
        sessionFile,
        options,
        recoveryPolicy.review_watchdog_finalize_timeout_seconds,
      );
      if (nudgeExecution) {
        finalizeNudgeIssued = true;
        requestId = requestId ?? extractRequestId(nudgeExecution.stdout, nudgeExecution.stderr);
        recoveryStderr = [recoveryStderr, '[WATCHDOG] finalize nudge issued', nudgeExecution.stderr]
          .filter(Boolean)
          .join('\n');
        const nudgePayload = recoverableAskPayload(stage, nudgeExecution.stdout, nudgeExecution.stderr, provider);
        if (nudgePayload !== null) {
          recoveryPayload = nudgePayload;
          recoveryPayloadSource = 'ask';
        }
      }

      if (recoveryPayload === null) {
        const lateRecovery = await recoverLateAskPayload(
          ctx,
          provider,
          stage,
          sessionRoot,
          sessionFile,
          options,
          {
            attempts: recoveryPolicy.review_watchdog_recovery_attempts,
            pollMs: recoveryPolicy.review_watchdog_recovery_poll_ms,
          },
        );
        pendAttempts += lateRecovery.attempts;
        recoveryPayload = lateRecovery.payload;
        if (lateRecovery.payload !== null) {
          recoveryPayloadSource = 'pend';
        }
      }
    } else if (requestId || shouldAttemptAnonymousLateRecovery(stage, execution.stdout, execution.stderr)) {
      const lateRecovery = await recoverLateAskPayload(ctx, provider, stage, sessionRoot, sessionFile, options);
      pendAttempts += lateRecovery.attempts;
      recoveryPayload = lateRecovery.payload;
      if (lateRecovery.payload !== null) {
        recoveryPayloadSource = 'pend';
      }
    }

    if (recoveryPayload !== null) {
      const latencySummary = buildDispatchLatencySummary({
        stage,
        exitCode: execution.exit_code,
        stdout: execution.stdout,
        stderr: execution.stderr,
        watchdogEngaged,
        finalizeNudgeIssued,
        foregroundRetryCount,
        pendAttempts,
        recoveredVia: recoveryPayloadSource,
      });
      if (dispatchId && stage !== 'handoff') {
        recordCcbDispatchState({
          repoRoot,
          dispatchId,
          requestId,
          provider,
          stage,
          status: recoveryPayloadSource === 'ask' ? 'completed' : 'recovered_late',
          payloadSource: recoveryPayloadSource,
          sessionRoot,
          sessionFile,
          executionWorkspace: executionCwd,
          dispatchCommand,
          dispatchedAt: dispatchAt,
          updatedAt: options.now(),
          askExitCode: execution.exit_code,
          stdout: recoveryPayload,
          stderr: recoveryStderr,
          retryProvenance,
          latencySummary,
        });
      }
      return {
        ...execution,
        stdout: recoveryPayload,
        stderr: recoveryStderr,
        request_id: requestId,
        latency_summary: latencySummary,
      };
    }

    const receiptRecovery = stage === 'review'
      ? reviewReceiptMatchesContext(ctx, provider)
      : null;
    if (receiptRecovery !== null) {
      const recoveryStderrWithReceipt = [
        recoveryStderr,
        '[RECEIPT] adopted current-attempt review receipt after transport recovery',
      ].filter(Boolean).join('\n');
      const latencySummary = buildDispatchLatencySummary({
        stage,
        exitCode: execution.exit_code,
        stdout: execution.stdout,
        stderr: recoveryStderrWithReceipt,
        watchdogEngaged,
        finalizeNudgeIssued,
        foregroundRetryCount,
        pendAttempts,
        recoveredVia: 'receipt',
      });
      if (dispatchId && stage !== 'handoff') {
        recordCcbDispatchState({
          repoRoot,
          dispatchId,
          requestId: receiptRecovery.requestId,
          provider,
          stage,
          status: 'recovered_late',
          payloadSource: 'receipt',
          sessionRoot,
          sessionFile,
          executionWorkspace: executionCwd,
          dispatchCommand,
          dispatchedAt: dispatchAt,
          updatedAt: options.now(),
          askExitCode: execution.exit_code,
          stdout: receiptRecovery.markdown,
          stderr: recoveryStderrWithReceipt,
          retryProvenance,
          latencySummary,
        });
      }
      return {
        ...execution,
        stdout: receiptRecovery.markdown,
        stderr: recoveryStderrWithReceipt,
        request_id: receiptRecovery.requestId,
        latency_summary: latencySummary,
      };
    }

    const latencySummary = buildDispatchLatencySummary({
      stage,
      exitCode: execution.exit_code,
      stdout: execution.stdout,
      stderr: recoveryStderr,
      watchdogEngaged,
      finalizeNudgeIssued,
      foregroundRetryCount,
      pendAttempts,
      recoveredVia: null,
    });
    if (dispatchId && stage !== 'handoff') {
      recordCcbDispatchState({
        repoRoot,
        dispatchId,
        requestId,
        provider,
        stage,
        status: 'blocked',
        payloadSource: null,
        sessionRoot,
        sessionFile,
        executionWorkspace: executionCwd,
        dispatchCommand,
        dispatchedAt: dispatchAt,
        updatedAt: options.now(),
        askExitCode: execution.exit_code,
        stdout: execution.stdout,
        stderr: recoveryStderr,
        retryProvenance,
        latencySummary,
      });
    }

    return blockedResult(
      ctx.stage,
      recoveryStderr.trim() || `CCB ${provider} dispatch failed`,
      {
        receipt: '',
        dispatch_command: dispatchCommand,
        exit_code: execution.exit_code,
        stdout: execution.stdout,
        stderr: recoveryStderr,
        request_id: requestId,
        latency_summary: latencySummary,
      },
      ctx.requested_route,
      traceability,
    );
  }

  const requestId = extractRequestId(execution.stdout, execution.stderr);
  const latencySummary = buildDispatchLatencySummary({
    stage,
    exitCode: execution.exit_code,
    stdout: execution.stdout,
    stderr: execution.stderr,
    watchdogEngaged: false,
    finalizeNudgeIssued: false,
    foregroundRetryCount,
    pendAttempts: 0,
    recoveredVia: 'ask',
  });
  if (dispatchId && stage !== 'handoff') {
    recordCcbDispatchState({
      repoRoot,
      dispatchId,
      requestId,
      provider,
      stage,
      status: 'completed',
      payloadSource: 'ask',
      sessionRoot,
      sessionFile,
      executionWorkspace: executionCwd,
      dispatchCommand,
      dispatchedAt: dispatchAt,
      updatedAt: options.now(),
      askExitCode: execution.exit_code,
      stdout: execution.stdout,
      stderr: execution.stderr,
      retryProvenance,
      latencySummary,
    });
  }

  return {
    ...execution,
    request_id: requestId,
    latency_summary: latencySummary,
  };
}

async function recoverLateAskPayload(
  ctx: NexusAdapterContext,
  provider: 'codex' | 'gemini',
  stage: 'handoff' | 'build' | 'review' | 'qa',
  sessionRoot: string,
  sessionFile: string | null,
  options: Required<CreateRuntimeCcbAdapterOptions>,
  recovery: {
    attempts?: number;
    pollMs?: number;
  } = {},
): Promise<{ payload: string | null; attempts: number }> {
  if (stage === 'handoff') {
    return { payload: null, attempts: 0 };
  }

  const toolPaths = options.resolveToolPaths();
  const pendArgv = [toolPaths.pend_path ?? 'pend', provider];
  if (sessionFile) {
    pendArgv.push('--session-file', sessionFile);
  }

  const policy = dispatchRecoveryPolicy(provider);
  const attempts = recovery.attempts ?? policy.late_recovery_attempts;
  const pollMs = recovery.pollMs ?? policy.late_recovery_poll_ms;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let execution: CcbCommandResult;
    try {
      execution = await options.runCommand({
        argv: pendArgv,
        cwd: sessionRoot,
        env: envForCwd(sessionRoot, sessionFile ? { CCB_SESSION_FILE: sessionFile } : {}),
        timeout_ms: 5_000,
      });
    } catch {
      execution = {
        exit_code: 1,
        stdout: '',
        stderr: '',
      };
    }

    const payload = recoverableAskPayload(stage, execution.stdout, execution.stderr, provider);
    if (execution.exit_code === 0 && payload !== null) {
      return { payload, attempts: attempt + 1 };
    }

    if (attempt < attempts - 1) {
      await options.sleep(pollMs);
    }
  }

  return { payload: null, attempts };
}

async function runReviewFinalizeNudge(
  ctx: NexusAdapterContext,
  provider: 'codex' | 'gemini',
  sessionRoot: string,
  sessionFile: string | null,
  options: Required<CreateRuntimeCcbAdapterOptions>,
  finalizeTimeoutSeconds: string,
): Promise<CcbCommandResult | null> {
  const toolPaths = options.resolveToolPaths();
  const executionCwd = executionWorkspacePath(ctx);
  const argv = [
    toolPaths.ask_path,
    provider,
    '--foreground',
    '--no-wrap',
    '--timeout',
    finalizeTimeoutSeconds,
  ];

  try {
    return await options.runCommand({
      argv,
      cwd: executionCwd,
      env: envForCwd(executionCwd, {
        CCB_CALLER: 'claude',
        CCB_ASKD_AUTOSTART: '1',
        CCB_ALLOW_FOREGROUND: '1',
        CCB_SESSION_FILE: sessionFile,
      }),
      stdin_text: buildAuditFinalizePrompt(ctx, provider),
      timeout_ms: Number(finalizeTimeoutSeconds) * 1000 + 10_000,
    });
  } catch (error) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resetProviderSession(
  ctx: NexusAdapterContext,
  provider: 'codex' | 'gemini',
  traceability: AdapterTraceability,
  options: Required<CreateRuntimeCcbAdapterOptions>,
): Promise<AdapterResult<any> | null> {
  const toolPaths = options.resolveToolPaths();
  const repoRoot = resolveRepositoryRoot(ctx.cwd);
  const sessionRoot = sessionRootPath(ctx, options);
  const sessionFile = sessionFileForProvider(sessionRoot, provider);
  const argv = [toolPaths.autonew_path, provider];

  let execution: CcbCommandResult;
  try {
    execution = await options.runCommand({
      argv,
      cwd: sessionRoot,
      env: envForCwd(sessionRoot, {
        CCB_CALLER: 'claude',
        CCB_SESSION_FILE: sessionFile,
      }),
      timeout_ms: 15_000,
    });
  } catch (error) {
    recordCcbAutonewProviderState({
      repoRoot,
      provider,
      sessionRoot,
      sessionFile,
      autonewOk: false,
      autonewOutput: error instanceof Error ? error.message : String(error),
      now: options.now(),
    });
    return blockedResult(
      ctx.stage,
      error instanceof Error ? error.message : String(error),
      {
        receipt: '',
        dispatch_command: describeCommand(argv),
      },
      ctx.requested_route,
      traceability,
    );
  }

  if (execution.exit_code !== 0) {
    recordCcbAutonewProviderState({
      repoRoot,
      provider,
      sessionRoot,
      sessionFile,
      autonewOk: false,
      autonewOutput: execution.stderr.trim() || execution.stdout.trim() || `CCB ${provider} session reset failed`,
      now: options.now(),
    });
    return blockedResult(
      ctx.stage,
      execution.stderr.trim() || execution.stdout.trim() || `CCB ${provider} session reset failed`,
      {
        receipt: '',
        dispatch_command: describeCommand(argv),
      },
      ctx.requested_route,
      traceability,
    );
  }

  recordCcbAutonewProviderState({
    repoRoot,
    provider,
    sessionRoot,
    sessionFile,
    autonewOk: true,
    autonewOutput: summarizeCommandOutput(execution.stdout, execution.stderr),
    now: options.now(),
  });

  const settleMs = dispatchRecoveryPolicy(provider).post_reset_settle_ms;
  if (settleMs > 0) {
    await options.sleep(settleMs);
  }

  return null;
}

export function createDefaultCcbAdapter(): CcbAdapter {
  const handoffPack = createHandoffStagePack();
  const buildPack = createBuildStagePack();
  const reviewPack = createReviewStagePack();
  const qaPack = createQaStagePack();

  return {
    resolve_route: async (ctx) => {
      const resolved = handoffPack.buildResolvedRoute(ctx);

      return successResult<CcbResolveRouteRaw>(
        resolved.raw_output,
        resolved.actual_route,
        ctx.requested_route,
        handoffPack.traceability(),
      );
    },
    execute_generator: async (ctx) => {
      const execution = buildPack.buildGeneratorExecution(ctx);

      return successResult<CcbExecuteGeneratorRaw>(
        execution.raw_output,
        execution.actual_route,
        ctx.requested_route,
        buildPack.executionTraceability(),
      );
    },
    execute_audit_a: async (ctx) =>
      successResult<CcbExecuteAuditRaw>(
        {
          markdown: reviewPack.buildAuditMarkdown('codex'),
          receipt: 'ccb-review-codex',
        },
        {
          provider: 'codex',
          route: ctx.requested_route?.evaluator_a ?? 'codex-via-ccb',
          substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
          transport: 'ccb',
          receipt_path: '.planning/current/review/adapter-output.json',
        },
        ctx.requested_route,
        reviewPack.auditTraceability('codex'),
      ),
    execute_audit_b: async (ctx) =>
      successResult<CcbExecuteAuditRaw>(
        {
          markdown: reviewPack.buildAuditMarkdown('gemini'),
          receipt: 'ccb-review-gemini',
        },
        {
          provider: 'gemini',
          route: ctx.requested_route?.evaluator_b ?? 'gemini-via-ccb',
          substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
          transport: 'ccb',
          receipt_path: '.planning/current/review/adapter-output.json',
        },
        ctx.requested_route,
        reviewPack.auditTraceability('gemini'),
      ),
    execute_qa: async (ctx) =>
      successResult<CcbExecuteQaRaw>(
        {
          report_markdown: qaPack.buildQaReport(ctx, true, []),
          ready: true,
          findings: [],
          receipt: 'ccb-qa',
        },
        {
          provider: 'gemini',
          route: ctx.requested_route?.generator ?? 'gemini-via-ccb',
          substrate: ctx.requested_route?.substrate ?? 'superpowers-core',
          transport: 'ccb',
          receipt_path: '.planning/current/qa/adapter-output.json',
        },
        ctx.requested_route,
        qaPack.validationTraceability(),
      ),
  };
}

export function createRuntimeCcbAdapter(
  providedOptions: CreateRuntimeCcbAdapterOptions = {},
): CcbAdapter {
  const handoffPack = createHandoffStagePack();
  const buildPack = createBuildStagePack();
  const reviewPack = createReviewStagePack();
  const qaPack = createQaStagePack();
  const options: Required<CreateRuntimeCcbAdapterOptions> = {
    resolveToolPaths: providedOptions.resolveToolPaths ?? defaultResolveToolPaths,
    resolveSessionRoot: providedOptions.resolveSessionRoot ?? defaultResolveSessionRoot,
    runCommand: providedOptions.runCommand ?? defaultRunCommand,
    now: providedOptions.now ?? (() => new Date().toISOString()),
    sleep: providedOptions.sleep ?? defaultSleep,
  };

  return {
    resolve_route: async (ctx) => runRouteVerification(ctx, handoffPack.traceability(), options),
    execute_generator: async (ctx) => {
      const traceability = buildPack.executionTraceability();
      const execution = await runAskDispatch(
        ctx,
        expectedProvider(ctx.requested_route?.generator ?? null) ?? 'codex',
        'build',
        buildGeneratorPrompt(ctx),
        traceability,
        options,
        false,
      );

      if ('adapter_id' in execution) {
        return execution;
      }

      const provider = expectedProvider(ctx.requested_route?.generator ?? null);
      const receipt = `ccb-build-${provider ?? 'unknown'}-${sanitizeReceiptTimestamp(options.now())}`;

      return successResult<CcbExecuteGeneratorRaw>(
        {
          receipt,
          summary_markdown: execution.stdout.trim(),
          dispatch_command: describeCommand([
            options.resolveToolPaths().ask_path,
            provider ?? 'codex',
            '--foreground',
            '--no-wrap',
            '--timeout',
            DEFAULT_TIMEOUTS_SECONDS.build,
          ]),
          exit_code: execution.exit_code,
          stdout: execution.stdout,
          stderr: execution.stderr,
          request_id: execution.request_id ?? extractRequestId(execution.stdout, execution.stderr),
          latency_summary: execution.latency_summary ?? null,
        },
        buildActualRoute(provider, ctx.requested_route?.generator ?? null, ctx.requested_route?.substrate ?? null, 'build'),
        ctx.requested_route,
        traceability,
      );
    },
    execute_audit_a: async (ctx) => {
      const traceability = reviewPack.auditTraceability('codex');
      const resetResult = await resetProviderSession(ctx, 'codex', traceability, options);
      if (resetResult) {
        return resetResult;
      }
      const execution = await runAskDispatch(
        ctx,
        'codex',
        'review',
        buildAuditPrompt(ctx, 'codex'),
        traceability,
        options,
        true,
      );

      if ('adapter_id' in execution) {
        return execution;
      }

      const markdown = extractCanonicalReviewAuditMarkdown(execution.stdout, 'codex');
      if (markdown === null) {
        return blockedResult(
          ctx.stage,
          'Malformed review response: expected a canonical "# Codex Audit" block with Result and Findings.',
          {
            receipt: '',
            dispatch_command: describeCommand([
              options.resolveToolPaths().ask_path,
              'codex',
              '--foreground',
              '--no-wrap',
              '--timeout',
              DEFAULT_TIMEOUTS_SECONDS.review,
            ]),
            exit_code: execution.exit_code,
            stdout: execution.stdout,
            stderr: execution.stderr,
            request_id: execution.request_id ?? extractRequestId(execution.stdout, execution.stderr),
            latency_summary: execution.latency_summary ?? null,
          },
          ctx.requested_route,
          traceability,
        );
      }

      const actualRoute = buildActualRoute('codex', ctx.requested_route?.evaluator_a ?? 'codex-via-ccb', ctx.requested_route?.substrate ?? null, 'review');
      if (ctx.review_attempt_id) {
        persistReviewAuditReceipt({
          cwd: ctx.cwd,
          review_attempt_id: ctx.review_attempt_id,
          provider: 'codex',
          markdown,
          record: buildReviewAuditReceiptRecord({
            review_attempt_id: ctx.review_attempt_id,
            provider: 'codex',
            request_id: execution.request_id ?? extractRequestId(execution.stdout, execution.stderr),
            generated_at: options.now(),
            requested_route: reviewRequestedRouteFromContext(ctx, 'codex'),
            actual_route: actualRoute,
            verdict: canonicalReviewAuditVerdict(markdown),
            markdown_path: reviewAttemptAuditMarkdownPath(ctx.review_attempt_id, 'codex'),
          }),
        });
      }

      return successResult<CcbExecuteAuditRaw>(
        {
          markdown,
          receipt: `ccb-review-codex-${sanitizeReceiptTimestamp(options.now())}`,
          dispatch_command: describeCommand([
            options.resolveToolPaths().ask_path,
            'codex',
            '--foreground',
            '--no-wrap',
            '--timeout',
            DEFAULT_TIMEOUTS_SECONDS.review,
          ]),
          exit_code: execution.exit_code,
          stdout: execution.stdout,
          stderr: execution.stderr,
          request_id: execution.request_id ?? extractRequestId(execution.stdout, execution.stderr),
          latency_summary: execution.latency_summary ?? null,
        },
        actualRoute,
        ctx.requested_route,
        traceability,
      );
    },
    execute_audit_b: async (ctx) => {
      const traceability = reviewPack.auditTraceability('gemini');
      const resetResult = await resetProviderSession(ctx, 'gemini', traceability, options);
      if (resetResult) {
        return resetResult;
      }
      const execution = await runAskDispatch(
        ctx,
        'gemini',
        'review',
        buildAuditPrompt(ctx, 'gemini'),
        traceability,
        options,
        true,
      );

      if ('adapter_id' in execution) {
        return execution;
      }

      const markdown = extractCanonicalReviewAuditMarkdown(execution.stdout, 'gemini');
      if (markdown === null) {
        return blockedResult(
          ctx.stage,
          'Malformed review response: expected a canonical "# Gemini Audit" block with Result and Findings.',
          {
            receipt: '',
            dispatch_command: describeCommand([
              options.resolveToolPaths().ask_path,
              'gemini',
              '--foreground',
              '--no-wrap',
              '--timeout',
              DEFAULT_TIMEOUTS_SECONDS.review,
            ]),
            exit_code: execution.exit_code,
            stdout: execution.stdout,
            stderr: execution.stderr,
            request_id: execution.request_id ?? extractRequestId(execution.stdout, execution.stderr),
            latency_summary: execution.latency_summary ?? null,
          },
          ctx.requested_route,
          traceability,
        );
      }

      const actualRoute = buildActualRoute('gemini', ctx.requested_route?.evaluator_b ?? 'gemini-via-ccb', ctx.requested_route?.substrate ?? null, 'review');
      if (ctx.review_attempt_id) {
        persistReviewAuditReceipt({
          cwd: ctx.cwd,
          review_attempt_id: ctx.review_attempt_id,
          provider: 'gemini',
          markdown,
          record: buildReviewAuditReceiptRecord({
            review_attempt_id: ctx.review_attempt_id,
            provider: 'gemini',
            request_id: execution.request_id ?? extractRequestId(execution.stdout, execution.stderr),
            generated_at: options.now(),
            requested_route: reviewRequestedRouteFromContext(ctx, 'gemini'),
            actual_route: actualRoute,
            verdict: canonicalReviewAuditVerdict(markdown),
            markdown_path: reviewAttemptAuditMarkdownPath(ctx.review_attempt_id, 'gemini'),
          }),
        });
      }

      return successResult<CcbExecuteAuditRaw>(
        {
          markdown,
          receipt: `ccb-review-gemini-${sanitizeReceiptTimestamp(options.now())}`,
          dispatch_command: describeCommand([
            options.resolveToolPaths().ask_path,
            'gemini',
            '--foreground',
            '--no-wrap',
            '--timeout',
            DEFAULT_TIMEOUTS_SECONDS.review,
          ]),
          exit_code: execution.exit_code,
          stdout: execution.stdout,
          stderr: execution.stderr,
          request_id: execution.request_id ?? extractRequestId(execution.stdout, execution.stderr),
          latency_summary: execution.latency_summary ?? null,
        },
        actualRoute,
        ctx.requested_route,
        traceability,
      );
    },
    execute_qa: async (ctx) => {
      const traceability = qaPack.validationTraceability();
      const resetResult = await resetProviderSession(ctx, 'gemini', traceability, options);
      if (resetResult) {
        return resetResult;
      }
      const execution = await runAskDispatch(
        ctx,
        'gemini',
        'qa',
        buildQaPrompt(ctx),
        traceability,
        options,
        true,
      );

      if ('adapter_id' in execution) {
        return execution;
      }

      try {
        const parsed = parseQaPayload(execution.stdout);

        return successResult<CcbExecuteQaRaw>(
          {
            ...parsed,
            receipt: `ccb-qa-gemini-${sanitizeReceiptTimestamp(options.now())}`,
            dispatch_command: describeCommand([
              options.resolveToolPaths().ask_path,
              'gemini',
              '--foreground',
              '--no-wrap',
              '--timeout',
              DEFAULT_TIMEOUTS_SECONDS.qa,
            ]),
            exit_code: execution.exit_code,
            stdout: execution.stdout,
            stderr: execution.stderr,
            request_id: execution.request_id ?? extractRequestId(execution.stdout, execution.stderr),
            latency_summary: execution.latency_summary ?? null,
          },
          buildActualRoute('gemini', ctx.requested_route?.generator ?? 'gemini-via-ccb', ctx.requested_route?.substrate ?? null, 'qa'),
          ctx.requested_route,
          traceability,
        );
      } catch (error) {
        return blockedResult(
          ctx.stage,
          error instanceof Error ? error.message : String(error),
          {
            report_markdown: '',
            ready: false,
            findings: [],
            receipt: '',
            dispatch_command: describeCommand([
              options.resolveToolPaths().ask_path,
              'gemini',
              '--foreground',
              '--no-wrap',
              '--timeout',
              DEFAULT_TIMEOUTS_SECONDS.qa,
            ]),
            exit_code: execution.exit_code,
            stdout: execution.stdout,
            stderr: execution.stderr,
            request_id: execution.request_id ?? extractRequestId(execution.stdout, execution.stderr),
            latency_summary: execution.latency_summary ?? null,
          },
          ctx.requested_route,
          traceability,
        );
      }
    },
  };
}
