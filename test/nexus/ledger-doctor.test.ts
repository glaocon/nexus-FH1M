import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { describe, expect, test } from 'bun:test';
import {
  closeoutDocumentationSyncPath,
  qaPerfVerificationPath,
  reviewAdvisoriesPath,
  reviewAdvisoryDispositionPath,
  reviewAttemptAuditMarkdownPath,
  reviewAttemptAuditReceiptPath,
  shipCanaryStatusPath,
  shipDeployResultPath,
  stageCompletionAdvisorPath,
} from '../../lib/nexus/artifacts';
import { applySafeLedgerDoctorFix, buildLedgerDoctorReport } from '../../lib/nexus/ledger-doctor';
import { buildReviewAuditReceiptRecord, persistReviewAuditReceipt } from '../../lib/nexus/review-receipts';
import { runInTempRepo } from './helpers/temp-repo';

function writeRepoFile(cwd: string, path: string, content: string): void {
  const absolutePath = join(cwd, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function writeRepoJson(cwd: string, path: string, value: unknown): void {
  writeRepoFile(cwd, path, JSON.stringify(value, null, 2) + '\n');
}

function writeCanonicalCurrentAuditFixture(cwd: string, metaJson: string): void {
  writeRepoJson(cwd, '.planning/nexus/current-run.json', {
    run_id: 'run-123',
    status: 'active',
    current_command: 'review',
    current_stage: 'review',
    previous_stage: 'build',
    allowed_next_stages: ['qa'],
    command_history: [
      { command: 'plan', at: '2026-04-30T00:00:00.000Z', via: null },
      { command: 'handoff', at: '2026-04-30T00:01:00.000Z', via: null },
      { command: 'build', at: '2026-04-30T00:02:00.000Z', via: null },
      { command: 'review', at: '2026-04-30T00:03:00.000Z', via: null },
    ],
    artifact_index: {},
    execution: { mode: 'local_provider' },
    route_intent: {},
  });
  writeRepoJson(cwd, '.planning/current/review/status.json', {
    run_id: 'run-123',
    stage: 'review',
    state: 'completed',
    decision: 'audit_recorded',
    ready: true,
    review_complete: true,
    audit_set_complete: true,
    provenance_consistent: true,
    gate_decision: 'pass',
    review_attempt_id: 'review-123',
    audit_request_ids: {
      codex: 'codex-request-123',
      gemini: 'gemini-request-123',
    },
  });
  writeRepoFile(cwd, '.planning/audits/current/codex.md', '# Codex Audit\n\nResult: pass\n');
  writeRepoFile(cwd, '.planning/audits/current/gemini.md', '# Gemini Audit\n\nResult: pass\n');
  writeRepoFile(cwd, '.planning/audits/current/gate-decision.md', 'Gate: pass\n');
  writeRepoFile(
    cwd,
    '.planning/audits/current/synthesis.md',
    'Codex audit result: pass\nGemini audit result: pass\n',
  );
  writeRepoFile(cwd, '.planning/audits/current/meta.json', metaJson);
}

describe('nexus ledger doctor', () => {
  test('reports clean for a canonical completed review history', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      expect(buildLedgerDoctorReport(cwd)).toEqual({
        status: 'clean',
        issues: [],
      });
    });
  });

  test('reports a noncanonical closeout history mismatch at review tail', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
        command_history: Array<{ command: string; at: string; via: string | null }>;
      };
      ledger.command_history = [
        ledger.command_history[0]!,
        ledger.command_history[1]!,
        ledger.command_history[2]!,
        {
          command: 'build',
          at: '2026-04-16T01:00:00.000Z',
          via: 'fix-cycle',
        },
        ledger.command_history[3]!,
      ];
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

      expect(buildLedgerDoctorReport(cwd)).toMatchObject({
        status: 'action_required',
        issues: [
          {
            code: 'history_mismatch',
            message: 'Illegal Nexus transition history: expected review after build at positions 3 -> 4, got build',
            evidence: ['.planning/nexus/current-run.json'],
          },
        ],
      });
    });
  });

  test('does not flag a legal fix-cycle build while the run is still in build', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const reviewStatusPath = join(cwd, '.planning/current/review/status.json');
      const reviewStatus = JSON.parse(readFileSync(reviewStatusPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(reviewStatusPath, JSON.stringify({
        ...reviewStatus,
        state: 'completed',
        decision: 'audit_recorded',
        gate_decision: 'fail',
        ready: false,
      }, null, 2) + '\n');

      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(ledgerPath, JSON.stringify({
        ...ledger,
        current_command: 'build',
        current_stage: 'build',
        previous_stage: 'review',
        allowed_next_stages: ['review'],
        command_history: [
          ...(ledger.command_history as Array<{ command: string; at: string; via: string | null }>),
          {
            command: 'build',
            at: '2026-04-16T01:05:00.000Z',
            via: 'fix-cycle',
          },
        ],
      }, null, 2) + '\n');

      expect(buildLedgerDoctorReport(cwd)).toEqual({
        status: 'clean',
        issues: [],
      });
    });
  });

  test('reports stale current audits when review is blocked but audit files remain', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const reviewStatusPath = join(cwd, '.planning/current/review/status.json');
      const reviewStatus = JSON.parse(readFileSync(reviewStatusPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(reviewStatusPath, JSON.stringify({
        ...reviewStatus,
        state: 'blocked',
        decision: 'none',
        review_complete: false,
        audit_set_complete: false,
        provenance_consistent: false,
        gate_decision: 'blocked',
      }, null, 2) + '\n');

      expect(buildLedgerDoctorReport(cwd)).toMatchObject({
        status: 'action_required',
        issues: [
          {
            code: 'stale_current_audits',
            message: 'Current audit artifacts exist but the review status is not a completed canonical audit record.',
          },
        ],
      });

      const staleIssue = buildLedgerDoctorReport(cwd).issues.find((issue) => issue.code === 'stale_current_audits');
      expect(staleIssue?.evidence).toEqual(expect.arrayContaining([
        '.planning/current/review/status.json',
        '.planning/audits/current/codex.md',
        '.planning/audits/current/gemini.md',
        '.planning/audits/current/synthesis.md',
        '.planning/audits/current/gate-decision.md',
        '.planning/audits/current/meta.json',
      ]));
    });
  });

  test('reports split-brain current audits when the canonical review set disagrees internally', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      writeFileSync(
        join(cwd, '.planning/audits/current/codex.md'),
        '# Codex Audit\n\nResult: fail\n\nFindings:\n- Manual override.\n',
      );

      expect(buildLedgerDoctorReport(cwd)).toMatchObject({
        status: 'action_required',
        issues: [
          expect.objectContaining({
            code: 'split_brain_current_audits',
          }),
        ],
      });

      const splitBrainIssue = buildLedgerDoctorReport(cwd).issues.find((issue) => issue.code === 'split_brain_current_audits');
      expect(splitBrainIssue?.evidence).toEqual(expect.arrayContaining([
        '.planning/current/review/status.json',
        '.planning/audits/current/codex.md',
        '.planning/audits/current/gemini.md',
        '.planning/audits/current/synthesis.md',
        '.planning/audits/current/gate-decision.md',
        '.planning/audits/current/meta.json',
      ]));
    });
  });

  test('reports split-brain current audits when current audit metadata has invalid shape', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-ledger-doctor-invalid-meta-'));
    try {
      writeCanonicalCurrentAuditFixture(cwd, '[]');
      const splitBrainIssue = buildLedgerDoctorReport(cwd).issues.find((issue) => issue.code === 'split_brain_current_audits');
      expect(splitBrainIssue).toMatchObject({
        code: 'split_brain_current_audits',
      });
      expect(splitBrainIssue?.evidence).toEqual(expect.arrayContaining([
        '.planning/current/review/status.json',
        '.planning/audits/current/meta.json',
      ]));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reports current audit read failures with a distinct issue code', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-ledger-doctor-read-failure-'));
    try {
      writeCanonicalCurrentAuditFixture(cwd, '{not valid json');
      const readFailureIssue = buildLedgerDoctorReport(cwd).issues.find((issue) => issue.code === 'current_audit_read_failed');
      expect(readFailureIssue).toMatchObject({
        code: 'current_audit_read_failed',
        message: expect.stringContaining('Failed to read current audit artifacts'),
      });
      expect(readFailureIssue?.evidence).toEqual(expect.arrayContaining([
        '.planning/current/review/status.json',
        '.planning/audits/current/meta.json',
      ]));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reports stale review receipts when a superseded attempt lands after the current review completed', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      persistReviewAuditReceipt({
        cwd,
        review_attempt_id: 'review-2026-04-21T12-00-00-000Z',
        provider: 'codex',
        markdown: '# Codex Audit\n\nResult: fail\n\nFindings:\n- stale late receipt\n',
        record: buildReviewAuditReceiptRecord({
          review_attempt_id: 'review-2026-04-21T12-00-00-000Z',
          provider: 'codex',
          request_id: '20260421-999999-1',
          generated_at: '2099-04-21T12:00:00.000Z',
          requested_route: {
            provider: 'codex',
            route: 'codex-via-ccb',
            substrate: 'superpowers-core',
            transport: 'ccb',
          },
          actual_route: {
            provider: 'codex',
            route: 'codex-via-ccb',
            substrate: 'superpowers-core',
            transport: 'ccb',
            receipt_path: '.planning/current/review/adapter-output.json',
          },
          verdict: 'fail',
          markdown_path: reviewAttemptAuditMarkdownPath('review-2026-04-21T12-00-00-000Z', 'codex'),
        }),
      });

      expect(buildLedgerDoctorReport(cwd)).toMatchObject({
        status: 'action_required',
        issues: [
          expect.objectContaining({
            code: 'stale_review_receipts',
          }),
        ],
      });

      const staleReceiptIssue = buildLedgerDoctorReport(cwd).issues.find((issue) => issue.code === 'stale_review_receipts');
      expect(staleReceiptIssue?.evidence).toEqual(expect.arrayContaining([
        reviewAttemptAuditMarkdownPath('review-2026-04-21T12-00-00-000Z', 'codex'),
        reviewAttemptAuditReceiptPath('review-2026-04-21T12-00-00-000Z', 'codex'),
      ]));
    });
  });

  test('reports and repairs review advisory drift so simplify can surface', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      writeFileSync(
        join(cwd, '.planning/audits/current/codex.md'),
        [
          '# Codex Audit',
          '',
          'Result: pass',
          '',
          'Findings:',
          '- none',
          '',
          'Advisories:',
          '- The implementation has duplicated branching and should be simplified without behavior changes.',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(cwd, '.planning/audits/current/gemini.md'),
        [
          '# Gemini Audit',
          '',
          'Result: pass',
          '',
          'Findings:',
          '- none',
          '',
          'Advisories:',
          '- Security-sensitive auth flow deserves a follow-up hardening pass.',
          '',
        ].join('\n'),
      );

      const reviewStatusPath = join(cwd, '.planning/current/review/status.json');
      const staleStatus = JSON.parse(readFileSync(reviewStatusPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(reviewStatusPath, JSON.stringify({
        ...staleStatus,
        advisories_path: null,
        advisory_count: 0,
        advisory_categories: [],
        advisory_disposition: null,
        advisory_disposition_path: null,
      }, null, 2) + '\n');

      expect(buildLedgerDoctorReport(cwd)).toMatchObject({
        status: 'action_required',
        issues: [
          expect.objectContaining({
            code: 'review_advisory_drift',
          }),
        ],
      });

      const fix = applySafeLedgerDoctorFix(cwd);
      expect(fix.fixed_issue_codes).toContain('review_advisory_drift');
      expect(fix.fixed_paths).toEqual(expect.arrayContaining([
        reviewAdvisoriesPath(),
        reviewAdvisoryDispositionPath(),
        stageCompletionAdvisorPath('review'),
        '.planning/current/review/status.json',
      ]));

      const repairedStatus = JSON.parse(readFileSync(reviewStatusPath, 'utf8')) as {
        advisory_count: number;
        advisory_categories: string[];
        advisories_path: string;
        advisory_disposition_path: string;
      };
      expect(repairedStatus).toMatchObject({
        advisory_count: 2,
        advisory_categories: ['maintainability', 'security'],
        advisories_path: reviewAdvisoriesPath(),
        advisory_disposition_path: reviewAdvisoryDispositionPath(),
      });

      const advisor = JSON.parse(readFileSync(join(cwd, stageCompletionAdvisorPath('review')), 'utf8')) as {
        interaction_mode: string;
        recommended_side_skills: Array<{ surface: string }>;
      };
      expect(advisor.interaction_mode).toBe('required_choice');
      expect(advisor.recommended_side_skills).toEqual(expect.arrayContaining([
        expect.objectContaining({ surface: '/simplify' }),
        expect.objectContaining({ surface: '/cso' }),
      ]));
      expect(buildLedgerDoctorReport(cwd)).toEqual({
        status: 'clean',
        issues: [],
      });
    });
  });

  test('reports and safely clears stale attached evidence without mutating command history', async () => {
    await runInTempRepo(async ({ cwd, run }) => {
      await run('plan');
      await run('handoff');
      await run('build');
      await run('review');

      const staleEvidence = [
        {
          path: qaPerfVerificationPath(),
          content: '# Perf Verification\n\n- stale\n',
        },
        {
          path: shipCanaryStatusPath(),
          content: JSON.stringify({ status: 'healthy' }, null, 2) + '\n',
        },
        {
          path: shipDeployResultPath(),
          content: JSON.stringify({ deploy_status: 'verified' }, null, 2) + '\n',
        },
        {
          path: closeoutDocumentationSyncPath(),
          content: '# Documentation Sync\n\n- stale\n',
        },
      ];

      for (const entry of staleEvidence) {
        mkdirSync(dirname(join(cwd, entry.path)), { recursive: true });
        writeFileSync(join(cwd, entry.path), entry.content);
      }

      const ledgerPath = join(cwd, '.planning/nexus/current-run.json');
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
        command_history: Array<{ command: string; at: string; via: string | null }>;
        artifact_index: Record<string, unknown>;
      };
      const originalHistory = structuredClone(ledger.command_history);
      ledger.artifact_index = {
        ...ledger.artifact_index,
        [qaPerfVerificationPath()]: { kind: 'markdown', path: qaPerfVerificationPath() },
        [shipCanaryStatusPath()]: { kind: 'json', path: shipCanaryStatusPath() },
        [shipDeployResultPath()]: { kind: 'json', path: shipDeployResultPath() },
        [closeoutDocumentationSyncPath()]: { kind: 'markdown', path: closeoutDocumentationSyncPath() },
      };
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

      expect(buildLedgerDoctorReport(cwd)).toMatchObject({
        status: 'action_required',
        issues: [
          expect.objectContaining({
            code: 'stale_attached_evidence',
          }),
        ],
      });

      const fix = applySafeLedgerDoctorFix(cwd);
      expect(fix.fixed_issue_codes).toContain('stale_attached_evidence');
      expect(fix.fixed_paths).toEqual(expect.arrayContaining([
        qaPerfVerificationPath(),
        shipCanaryStatusPath(),
        shipDeployResultPath(),
        closeoutDocumentationSyncPath(),
      ]));
      expect(buildLedgerDoctorReport(cwd)).toEqual({
        status: 'clean',
        issues: [],
      });

      for (const entry of staleEvidence) {
        expect(existsSync(join(cwd, entry.path))).toBe(false);
      }

      const nextLedger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
        command_history: Array<{ command: string; at: string; via: string | null }>;
        artifact_index: Record<string, unknown>;
      };
      expect(nextLedger.command_history).toEqual(originalHistory);
      expect(nextLedger.artifact_index[qaPerfVerificationPath()]).toBeUndefined();
      expect(nextLedger.artifact_index[shipCanaryStatusPath()]).toBeUndefined();
      expect(nextLedger.artifact_index[shipDeployResultPath()]).toBeUndefined();
      expect(nextLedger.artifact_index[closeoutDocumentationSyncPath()]).toBeUndefined();
    });
  });
});
