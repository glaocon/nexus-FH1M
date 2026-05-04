import { describe, expect, test } from 'bun:test';
import {
  assertCanonicalTailLedger,
  RunLedgerCanonicalError,
  type RunLedgerCanonicalErrorCode,
} from '../../lib/nexus/governance';
import type { RunLedger } from '../../lib/nexus/types';

function canonicalLedger(overrides: Record<string, unknown> = {}): RunLedger {
  return {
    command_history: [
      { command: 'plan', at: '2026-04-30T00:00:00.000Z', via: null },
    ],
    execution: { mode: 'governed_ccb' },
    route_check: {
      checked_at: '2026-04-30T00:00:00.000Z',
      requested_route: { provider: 'codex', route: 'codex-via-ccb' },
      route_validation: {
        transport: 'local',
        available: true,
        approved: true,
        reason: 'ok',
      },
    },
    ...overrides,
  } as unknown as RunLedger;
}

function ccbRouteValidation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: 'ccb',
    available: true,
    approved: true,
    reason: 'ok',
    provider_checks: [
      {
        provider: 'codex',
        available: true,
        mounted: true,
        reason: 'mounted',
      },
    ],
    ...overrides,
  };
}

function expectCanonicalErrorCode(ledger: RunLedger, code: RunLedgerCanonicalErrorCode): void {
  try {
    assertCanonicalTailLedger(ledger, 'QA');
    throw new Error('expected canonical ledger assertion to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RunLedgerCanonicalError);
    expect((error as RunLedgerCanonicalError).code).toBe(code);
    expect((error as Error).message).toContain(`(${code})`);
  }
}

describe('nexus governance canonical errors', () => {
  test('preserves gate wording while exposing a stable diagnostic code', () => {
    const ledger = {
      command_history: [
        { at: '2026-04-30T00:00:00.000Z', command: 'plan', via: null, extra: true },
      ],
      execution: { mode: 'local_provider' },
    } as unknown as RunLedger;

    try {
      assertCanonicalTailLedger(ledger, 'QA');
      throw new Error('expected canonical ledger assertion to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RunLedgerCanonicalError);
      expect((error as RunLedgerCanonicalError).code).toBe('command_history_entry_keys');
      expect((error as Error).message).toContain('Run ledger is not canonical before QA');
    }
  });

  const malformedLedgerCases: Array<{ code: RunLedgerCanonicalErrorCode; ledger: RunLedger }> = [
    {
      code: 'command_history_missing',
      ledger: canonicalLedger({ command_history: null }),
    },
    {
      code: 'command_history_entry_shape',
      ledger: canonicalLedger({ command_history: [null] }),
    },
    {
      code: 'command_history_entry_keys',
      ledger: canonicalLedger({
        command_history: [
          { at: '2026-04-30T00:00:00.000Z', command: 'plan', via: null, extra: true },
        ],
      }),
    },
    {
      code: 'command_history_command',
      ledger: canonicalLedger({
        command_history: [
          { at: '2026-04-30T00:00:00.000Z', command: 'invented', via: null },
        ],
      }),
    },
    {
      code: 'command_history_at',
      ledger: canonicalLedger({
        command_history: [
          { at: '', command: 'plan', via: null },
        ],
      }),
    },
    {
      code: 'command_history_via',
      ledger: canonicalLedger({
        command_history: [
          { at: '2026-04-30T00:00:00.000Z', command: 'plan', via: 'invented' },
        ],
      }),
    },
    {
      code: 'route_check_missing',
      ledger: canonicalLedger({ route_check: null }),
    },
    {
      code: 'route_check_checked_at',
      ledger: canonicalLedger({
        route_check: {
          checked_at: '',
          requested_route: { provider: 'codex', route: 'codex-via-ccb' },
          route_validation: ccbRouteValidation(),
        },
      }),
    },
    {
      code: 'route_check_requested_route',
      ledger: canonicalLedger({
        route_check: {
          checked_at: '2026-04-30T00:00:00.000Z',
          requested_route: null,
          route_validation: ccbRouteValidation(),
        },
      }),
    },
    {
      code: 'route_check_validation',
      ledger: canonicalLedger({
        route_check: {
          checked_at: '2026-04-30T00:00:00.000Z',
          requested_route: { provider: 'codex', route: 'codex-via-ccb' },
          route_validation: null,
        },
      }),
    },
    {
      code: 'route_check_provider_checks',
      ledger: canonicalLedger({
        route_check: {
          checked_at: '2026-04-30T00:00:00.000Z',
          requested_route: { provider: 'codex', route: 'codex-via-ccb' },
          route_validation: ccbRouteValidation({ provider_checks: [] }),
        },
      }),
    },
    {
      code: 'route_check_provider_check',
      ledger: canonicalLedger({
        route_check: {
          checked_at: '2026-04-30T00:00:00.000Z',
          requested_route: { provider: 'codex', route: 'codex-via-ccb' },
          route_validation: ccbRouteValidation({ provider_checks: [{ provider: 'codex' }] }),
        },
      }),
    },
    {
      code: 'canonical_validation_failed',
      ledger: canonicalLedger({ execution: null }),
    },
  ];

  for (const { code, ledger } of malformedLedgerCases) {
    test(`emits ${code} for malformed canonical ledger input`, () => {
      expectCanonicalErrorCode(ledger, code);
    });
  }
});
