import { cpSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { archiveRootFor } from './artifacts';
import { CANONICAL_COMMANDS, COMMAND_HISTORY_VIAS } from './types';
import type { RunLedger, StageStatus } from './types';
import { getAllowedNextStages } from './transitions';

export function archiveRequired(reviewStatus: StageStatus): boolean {
  return reviewStatus.state === 'completed' && reviewStatus.decision === 'audit_recorded';
}

export function assertSameRunId(expected: string, actual: string, label: string): void {
  if (expected !== actual) {
    throw new Error(`Run ID mismatch for ${label}: expected ${expected}, got ${actual}`);
  }
}

function assertCanonicalCommandHistoryEntry(entry: unknown): void {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Run ledger is not canonical');
  }

  const keys = Object.keys(entry).sort();
  if (keys.length !== 3 || keys[0] !== 'at' || keys[1] !== 'command' || keys[2] !== 'via') {
    throw new Error('Run ledger is not canonical');
  }

  const record = entry as Record<string, unknown>;
  if (!CANONICAL_COMMANDS.includes(record.command as typeof CANONICAL_COMMANDS[number])) {
    throw new Error('Run ledger is not canonical');
  }

  if (typeof record.at !== 'string' || record.at.trim().length === 0) {
    throw new Error('Run ledger is not canonical');
  }

  if (record.via !== null && !COMMAND_HISTORY_VIAS.includes(record.via as typeof COMMAND_HISTORY_VIAS[number])) {
    throw new Error('Run ledger is not canonical');
  }
}

function assertCanonicalRunLevelRouteCheck(ledger: RunLedger): void {
  if (ledger.execution.mode !== 'governed_ccb') {
    return;
  }

  if (!ledger.route_check || typeof ledger.route_check !== 'object') {
    throw new Error('Run ledger is not canonical');
  }

  if (typeof ledger.route_check.checked_at !== 'string' || ledger.route_check.checked_at.trim().length === 0) {
    throw new Error('Run ledger is not canonical');
  }

  if (!ledger.route_check.requested_route || typeof ledger.route_check.requested_route !== 'object') {
    throw new Error('Run ledger is not canonical');
  }

  const routeValidation = ledger.route_check.route_validation;
  if (!routeValidation || typeof routeValidation !== 'object') {
    throw new Error('Run ledger is not canonical');
  }

  if (
    typeof routeValidation.transport !== 'string'
    || typeof routeValidation.available !== 'boolean'
    || typeof routeValidation.approved !== 'boolean'
    || typeof routeValidation.reason !== 'string'
  ) {
    throw new Error('Run ledger is not canonical');
  }

  if (routeValidation.transport === 'ccb') {
    if (!Array.isArray(routeValidation.provider_checks) || routeValidation.provider_checks.length === 0) {
      throw new Error('Run ledger is not canonical');
    }

    for (const check of routeValidation.provider_checks) {
      if (
        !check
        || typeof check !== 'object'
        || typeof check.provider !== 'string'
        || typeof check.available !== 'boolean'
        || typeof check.mounted !== 'boolean'
        || typeof check.reason !== 'string'
      ) {
        throw new Error('Run ledger is not canonical');
      }
    }
  }
}

export function assertCanonicalTailLedger(ledger: RunLedger, label: 'QA' | 'ship'): void {
  if (!Array.isArray(ledger.command_history)) {
    throw new Error(`Run ledger is not canonical before ${label}`);
  }

  for (const entry of ledger.command_history) {
    try {
      assertCanonicalCommandHistoryEntry(entry);
    } catch {
      throw new Error(`Run ledger is not canonical before ${label}`);
    }
  }

  try {
    assertCanonicalRunLevelRouteCheck(ledger);
  } catch {
    throw new Error(`Run ledger is not canonical before ${label}`);
  }
}

export function gateRequiresArchive(gateDecisionMarkdown: string): boolean {
  return /Gate:\s*pass/i.test(gateDecisionMarkdown);
}

export function assertExpectedHistory(
  ledger: RunLedger,
  expected: RunLedger['command_history'][number]['command'][],
): void {
  const actual = ledger.command_history.map((entry) => entry.command);
  if (actual.length !== expected.length) {
    throw new Error('Illegal Nexus transition history');
  }

  for (const [index, command] of expected.entries()) {
    if (actual[index] !== command) {
      throw new Error('Illegal Nexus transition history');
    }
  }
}

export function assertExpectedHistoryOneOf(
  ledger: RunLedger,
  expectedHistories: RunLedger['command_history'][number]['command'][][],
): void {
  for (const expected of expectedHistories) {
    try {
      assertExpectedHistory(ledger, expected);
      return;
    } catch {
      // Try the next expected history.
    }
  }

  throw new Error('Illegal Nexus transition history');
}

function historyCommandAt(
  actual: RunLedger['command_history'][number]['command'][],
  index: number,
): string {
  return actual[index] ?? 'end of history';
}

function closeoutHistoryError(message: string): string {
  return `Illegal Nexus transition history: ${message}`;
}

function diagnoseFixCycleHistory(
  actual: RunLedger['command_history'][number]['command'][],
  options: { qaRecorded: boolean; shipRecorded: boolean },
): string | null {
  let cursor = 0;

  if (actual[cursor] === 'discover') {
    cursor += 1;
  }

  if (actual[cursor] === 'frame') {
    cursor += 1;
  }

  const expectedPrefix: RunLedger['command_history'][number]['command'][] = ['plan', 'handoff'];
  if (actual.length < cursor + expectedPrefix.length + 2) {
    return closeoutHistoryError(
      `expected plan -> handoff -> build -> review prefix, got ${actual.join(' -> ') || 'empty history'}`,
    );
  }

  for (const [index, command] of expectedPrefix.entries()) {
    const actualIndex = cursor + index;
    if (actual[actualIndex] !== command) {
      return closeoutHistoryError(
        `expected ${command} at position ${actualIndex + 1}, got ${historyCommandAt(actual, actualIndex)}`,
      );
    }
  }

  cursor += expectedPrefix.length;
  while (actual[cursor] === 'handoff') {
    cursor += 1;
  }

  if (actual[cursor] !== 'build') {
    return closeoutHistoryError(
      `expected build at position ${cursor + 1}, got ${historyCommandAt(actual, cursor)}`,
    );
  }

  if (actual[cursor + 1] !== 'review') {
    return closeoutHistoryError(
      `expected review after build at positions ${cursor + 1} -> ${cursor + 2}, got ${historyCommandAt(actual, cursor + 1)}`,
    );
  }

  cursor += 2;
  let previous: RunLedger['command_history'][number]['command'] = 'review';
  let firstQaIndex: number | null = null;
  let firstShipIndex: number | null = null;

  while (cursor < actual.length) {
    const current = actual[cursor]!;

    if (previous === 'build' && current !== 'review') {
      return closeoutHistoryError(
        `expected review after build at positions ${cursor} -> ${cursor + 1}, got ${current}`,
      );
    }

    if (!getAllowedNextStages(previous).includes(current)) {
      return closeoutHistoryError(
        `illegal ${previous} -> ${current} at positions ${cursor} -> ${cursor + 1}`,
      );
    }

    if (current === 'qa' && firstQaIndex === null) {
      firstQaIndex = cursor;
    }
    if (current === 'ship' && firstShipIndex === null) {
      firstShipIndex = cursor;
    }

    previous = current;
    cursor += 1;
  }

  if (options.qaRecorded && firstQaIndex === null) {
    return closeoutHistoryError(
      `expected qa before ${options.shipRecorded ? 'ship' : 'end of history'}, got ${options.shipRecorded ? 'ship' : 'end of history'}`,
    );
  }

  if (!options.qaRecorded && firstQaIndex !== null) {
    return closeoutHistoryError(
      `unexpected qa at position ${firstQaIndex + 1}; expected end of history`,
    );
  }

  if (options.shipRecorded && firstShipIndex === null) {
    return closeoutHistoryError('expected ship before end of history, got end of history');
  }

  if (!options.shipRecorded && firstShipIndex !== null) {
    return closeoutHistoryError(
      `unexpected ship at position ${firstShipIndex + 1}; expected end of history`,
    );
  }

  return null;
}

export function diagnoseCloseoutHistory(
  ledger: RunLedger,
  options: { qaRecorded: boolean; shipRecorded: boolean },
): string | null {
  const actual = ledger.command_history.map((entry) => entry.command);
  return diagnoseFixCycleHistory(actual, options);
}

export function assertCloseoutHistory(
  ledger: RunLedger,
  options: { qaRecorded: boolean; shipRecorded: boolean },
): void {
  const error = diagnoseCloseoutHistory(ledger, options);
  if (error) {
    throw new Error(error);
  }
}

export function archiveAuditWorkspace(runId: string, cwd: string): string {
  const source = join(cwd, '.planning', 'audits', 'current');
  const destination = join(cwd, archiveRootFor(runId));
  cpSync(source, destination, { recursive: true, force: true });
  return archiveRootFor(runId);
}

export function assertArchiveConsistency(runId: string, reviewStatus: StageStatus, cwd: string): void {
  if (reviewStatus.archive_required !== true) {
    return;
  }

  const archiveRoot = join(cwd, archiveRootFor(runId));
  for (const file of ['codex.md', 'gemini.md', 'synthesis.md', 'gate-decision.md', 'meta.json']) {
    const filePath = join(archiveRoot, file);
    if (!existsSync(filePath)) {
      throw new Error(`Missing archived audit artifact: ${file}`);
    }

    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) {
      throw new Error(`Missing archived audit artifact: ${file}`);
    }
  }
}

export function archiveExists(runId: string, cwd: string): boolean {
  return existsSync(join(cwd, archiveRootFor(runId)));
}

export function assertReviewReadyForCloseout(reviewStatus: StageStatus, cwd: string): void {
  if (
    reviewStatus.state !== 'completed'
    || reviewStatus.decision !== 'audit_recorded'
    || reviewStatus.ready !== true
    || reviewStatus.audit_set_complete !== true
    || reviewStatus.provenance_consistent !== true
    || reviewStatus.gate_decision !== 'pass'
  ) {
    throw new Error('Review must be completed before closeout');
  }

  const requiredPaths = [
    '.planning/audits/current/codex.md',
    '.planning/audits/current/gemini.md',
    '.planning/audits/current/synthesis.md',
    '.planning/audits/current/gate-decision.md',
    '.planning/audits/current/meta.json',
  ];

  for (const path of requiredPaths) {
    if (!existsSync(join(cwd, path))) {
      throw new Error(`Missing required audit artifact: ${path}`);
    }
  }
}

export function assertQaReadyForCloseout(qaStatus: StageStatus | null): void {
  if (!qaStatus) {
    return;
  }

  if (
    qaStatus.stage !== 'qa'
    || qaStatus.state !== 'completed'
    || qaStatus.decision !== 'qa_recorded'
    || qaStatus.ready !== true
  ) {
    throw new Error('QA must be ready before closeout');
  }
}

export function assertShipReadyForCloseout(shipStatus: StageStatus | null): void {
  if (!shipStatus) {
    return;
  }

  if (
    shipStatus.stage !== 'ship'
    || shipStatus.state !== 'completed'
    || shipStatus.decision !== 'ship_recorded'
    || shipStatus.ready !== true
  ) {
    throw new Error('Ship must be ready before closeout');
  }
}
