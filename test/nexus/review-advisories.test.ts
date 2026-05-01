import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  reviewAdvisoriesPath,
  reviewAdvisoryDispositionPath,
} from '../../lib/nexus/artifacts';
import {
  advisoryDispositionPermitsStage,
  buildReviewAdvisoriesRecord,
  buildReviewAdvisoryDispositionRecord,
  effectiveReviewAdvisoryDisposition,
  readReviewAdvisories,
  readReviewAdvisoryDisposition,
  requiredReviewAdvisoryDispositionError,
} from '../../lib/nexus/review-advisories';
import type { StageStatus } from '../../lib/nexus/types';

const tempRepos: string[] = [];

function makeTempRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'nexus-review-advisories-'));
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

function reviewStatus(overrides: Partial<StageStatus> = {}): StageStatus {
  return {
    run_id: 'run-review-advisories',
    stage: 'review',
    state: 'completed',
    decision: 'audit_recorded',
    ready: true,
    inputs: [],
    outputs: [],
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:01:00.000Z',
    errors: [],
    ...overrides,
  };
}

describe('review advisories record building', () => {
  test('extracts, normalizes, dedupes, and classifies external advisory markdown', () => {
    const codexMarkdown = [
      '# Codex Audit',
      '',
      'Advisories:',
      '- Add regression tests for auth middleware.',
      '- none',
      '',
      'Findings:',
      '- not advisory content',
      '- Advisory: Refactor duplicate data mapping for readability.',
    ].join('\n');
    const geminiMarkdown = [
      '# Gemini Audit',
      '',
      'Advisories:',
      '- add   regression tests for auth middleware.',
      '- Improve keyboard focus order in the settings panel.',
    ].join('\n');

    expect(buildReviewAdvisoriesRecord(
      'run-123',
      '2026-01-01T00:00:00.000Z',
      codexMarkdown,
      geminiMarkdown,
    )).toEqual({
      schema_version: 1,
      run_id: 'run-123',
      generated_at: '2026-01-01T00:00:00.000Z',
      advisories: [
        'Add regression tests for auth middleware.',
        'Refactor duplicate data mapping for readability.',
        'Improve keyboard focus order in the settings panel.',
      ],
      categories: ['accessibility', 'maintainability', 'security', 'testing'],
    });
  });

  test('returns null when external audits carry no actionable advisories', () => {
    expect(buildReviewAdvisoriesRecord(
      'run-123',
      '2026-01-01T00:00:00.000Z',
      'Advisories:\n- none\n',
      '# Gemini Audit\n\nResult: pass\n',
    )).toBeNull();
  });
});

describe('readReviewAdvisories', () => {
  test('normalizes persisted advisory records and canonicalizes categories', () => {
    const cwd = makeTempRepo();
    writeRepoJson(cwd, reviewAdvisoriesPath(), {
      run_id: 'run-123',
      generated_at: '2026-01-01T00:00:00.000Z',
      advisories: [
        '  Add regression tests for auth middleware.  ',
        'add   regression tests for auth middleware.',
        'none',
        42,
        'Refactor duplicate data mapping for readability.',
      ],
      categories: ['testing', 'unknown', 'security', 'testing', 'maintainability'],
    });

    expect(readReviewAdvisories(cwd)).toEqual({
      schema_version: 1,
      run_id: 'run-123',
      generated_at: '2026-01-01T00:00:00.000Z',
      advisories: [
        'Add regression tests for auth middleware.',
        'Refactor duplicate data mapping for readability.',
      ],
      categories: ['maintainability', 'security', 'testing'],
    });
  });

  test('falls back to advisory text classification when categories are absent', () => {
    const cwd = makeTempRepo();
    writeRepoJson(cwd, reviewAdvisoriesPath(), {
      advisories: [
        'Improve keyboard focus order.',
        'Benchmark the slow query path.',
      ],
    });

    expect(readReviewAdvisories(cwd)).toMatchObject({
      run_id: '',
      generated_at: '',
      categories: ['accessibility', 'performance'],
    });
  });

  test('returns null for missing, malformed, or non-advisory payloads', () => {
    const cwd = makeTempRepo();

    expect(readReviewAdvisories(cwd)).toBeNull();

    writeRepoFile(cwd, reviewAdvisoriesPath(), '{not valid json');
    expect(readReviewAdvisories(cwd)).toBeNull();

    writeRepoJson(cwd, reviewAdvisoriesPath(), { advisories: 'not an array' });
    expect(readReviewAdvisories(cwd)).toBeNull();
  });
});

describe('review advisory dispositions', () => {
  test('normalizes persisted disposition records', () => {
    const cwd = makeTempRepo();
    writeRepoJson(cwd, reviewAdvisoryDispositionPath(), {
      run_id: 'run-123',
      advisory_count: 2,
      selected: 'defer_to_follow_on',
      selected_at: '2026-01-01T00:00:00.000Z',
    });

    expect(readReviewAdvisoryDisposition(cwd)).toEqual({
      schema_version: 1,
      run_id: 'run-123',
      advisory_count: 2,
      selected: 'defer_to_follow_on',
      selected_at: '2026-01-01T00:00:00.000Z',
      available_options: ['continue_to_qa', 'fix_before_qa', 'defer_to_follow_on'],
    });
  });

  test('coerces invalid disposition fields to safe defaults', () => {
    const cwd = makeTempRepo();
    writeRepoJson(cwd, reviewAdvisoryDispositionPath(), {
      run_id: 42,
      advisory_count: -1,
      selected: 'invented',
      selected_at: false,
    });

    expect(readReviewAdvisoryDisposition(cwd)).toEqual({
      schema_version: 1,
      run_id: '',
      advisory_count: 0,
      selected: null,
      selected_at: null,
      available_options: ['continue_to_qa', 'fix_before_qa', 'defer_to_follow_on'],
    });
  });

  test('returns null for missing, malformed, or non-object disposition payloads', () => {
    const cwd = makeTempRepo();

    expect(readReviewAdvisoryDisposition(cwd)).toBeNull();

    writeRepoFile(cwd, reviewAdvisoryDispositionPath(), '{not valid json');
    expect(readReviewAdvisoryDisposition(cwd)).toBeNull();

    writeRepoJson(cwd, reviewAdvisoryDispositionPath(), ['continue_to_qa']);
    expect(readReviewAdvisoryDisposition(cwd)).toBeNull();
  });

  test('applies override, status, and persisted disposition precedence', () => {
    const cwd = makeTempRepo();
    writeRepoJson(cwd, reviewAdvisoryDispositionPath(), buildReviewAdvisoryDispositionRecord(
      'run-123',
      1,
      'defer_to_follow_on',
      '2026-01-01T00:00:00.000Z',
    ));

    expect(effectiveReviewAdvisoryDisposition(
      cwd,
      reviewStatus({ advisory_disposition: 'continue_to_qa' }),
      'fix_before_qa',
    )).toBe('fix_before_qa');
    expect(effectiveReviewAdvisoryDisposition(
      cwd,
      reviewStatus({ advisory_disposition: 'continue_to_qa' }),
      null,
    )).toBe('continue_to_qa');
    expect(effectiveReviewAdvisoryDisposition(cwd, reviewStatus(), null)).toBe('defer_to_follow_on');
  });

  test('keeps stage gating policy explicit', () => {
    expect(advisoryDispositionPermitsStage('build', 'fix_before_qa')).toBe(true);
    expect(advisoryDispositionPermitsStage('build', 'continue_to_qa')).toBe(false);
    expect(advisoryDispositionPermitsStage('qa', 'continue_to_qa')).toBe(true);
    expect(advisoryDispositionPermitsStage('ship', 'defer_to_follow_on')).toBe(true);
    expect(advisoryDispositionPermitsStage('closeout', null)).toBe(false);
    expect(requiredReviewAdvisoryDispositionError('ship')).toContain('--review-advisory-disposition');
  });
});
