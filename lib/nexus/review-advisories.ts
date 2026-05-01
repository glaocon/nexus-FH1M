import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { reviewAdvisoriesPath, reviewAdvisoryDispositionPath } from './artifacts';
import { extractAdvisoriesSection } from './review-scope';
import {
  REVIEW_ADVISORY_DISPOSITIONS,
  type ReviewAdvisoriesRecord,
  type ReviewAdvisoryDisposition,
  type ReviewAdvisoryDispositionRecord,
  type StageStatus,
  type VerificationChecklistCategory,
} from './types';
import { isRecord, readJsonResult } from './validation-helpers';

const REVIEW_ADVISORY_CATEGORIES: readonly VerificationChecklistCategory[] = [
  'testing',
  'security',
  'maintainability',
  'performance',
  'accessibility',
  'design',
] as const;

function normalizeAdvisory(advisory: string): string {
  return advisory.replace(/\s+/g, ' ').trim();
}

function dedupeAdvisories(advisories: string[]): string[] {
  const deduped = new Map<string, string>();

  for (const advisory of advisories) {
    const normalized = normalizeAdvisory(advisory);
    if (!normalized || normalized.toLowerCase() === 'none') {
      continue;
    }

    const key = normalized.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }

  return [...deduped.values()];
}

function readJsonObject(path: string): Record<string, unknown> | null {
  const result = readJsonResult<Record<string, unknown>>(path);
  return result.ok && isRecord(result.value) ? result.value : null;
}

function normalizeAdvisoryCategories(
  categories: unknown,
  advisories: string[],
): VerificationChecklistCategory[] {
  if (!Array.isArray(categories)) {
    return classifyReviewAdvisoryCategories(advisories);
  }

  const normalized = new Set<VerificationChecklistCategory>();
  for (const value of categories) {
    if (
      typeof value === 'string'
      && (REVIEW_ADVISORY_CATEGORIES as readonly string[]).includes(value)
    ) {
      normalized.add(value as VerificationChecklistCategory);
    }
  }
  return [...normalized].sort();
}

const ADVISORY_CATEGORY_PATTERNS: Array<{
  category: VerificationChecklistCategory;
  patterns: RegExp[];
}> = [
  {
    category: 'maintainability',
    patterns: [
      /\bsimplif/i,
      /\brefactor/i,
      /\breadab/i,
      /\bmaintain/i,
      /\bcomplex/i,
      /\bduplicat/i,
      /\bdead code\b/i,
      /\bunused\b/i,
      /\bmagic (number|string)\b/i,
      /\bover[- ]?engineer/i,
      /\bDRY\b/,
      /\blong function\b/i,
      /\bnested\b/i,
      /\bclever\b/i,
    ],
  },
  {
    category: 'security',
    patterns: [
      /\bsecurity\b/i,
      /\bharden/i,
      /\bauth/i,
      /\bpermission/i,
      /\brbac\b/i,
      /\bsecret/i,
      /\btoken\b/i,
      /\binjection\b/i,
      /\bxss\b/i,
      /\bcsrf\b/i,
      /\bssrf\b/i,
      /\bowasp\b/i,
    ],
  },
  {
    category: 'performance',
    patterns: [
      /\bperformance\b/i,
      /\bperf\b/i,
      /\bbenchmark\b/i,
      /\blatency\b/i,
      /\bslow\b/i,
      /\bbundle\b/i,
      /\bN\+1\b/i,
      /\bquery\b/i,
      /\bpagination\b/i,
      /\bcore web vitals\b/i,
      /\bmeasurement\b/i,
    ],
  },
  {
    category: 'accessibility',
    patterns: [
      /\baccessib/i,
      /\ba11y\b/i,
      /\bkeyboard\b/i,
      /\bfocus\b/i,
      /\bscreen reader\b/i,
      /\baria\b/i,
    ],
  },
  {
    category: 'design',
    patterns: [
      /\bdesign\b/i,
      /\bvisual\b/i,
      /\bUI\b/,
      /\bUX\b/,
      /\blayout\b/i,
      /\bspacing\b/i,
      /\bbrand\b/i,
    ],
  },
  {
    category: 'testing',
    patterns: [
      /\btest\b/i,
      /\bcoverage\b/i,
      /\bregression\b/i,
      /\bfixture\b/i,
    ],
  },
];

export function classifyReviewAdvisoryCategories(advisories: string[]): VerificationChecklistCategory[] {
  const categories = new Set<VerificationChecklistCategory>();
  for (const advisory of advisories) {
    for (const rule of ADVISORY_CATEGORY_PATTERNS) {
      if (rule.patterns.some((pattern) => pattern.test(advisory))) {
        categories.add(rule.category);
      }
    }
  }
  return [...categories].sort();
}

export function buildReviewAdvisoriesRecord(
  runId: string,
  generatedAt: string,
  codexMarkdown: string,
  geminiMarkdown: string,
): ReviewAdvisoriesRecord | null {
  const advisories = dedupeAdvisories([
    ...extractAdvisoriesSection(codexMarkdown),
    ...extractAdvisoriesSection(geminiMarkdown),
  ]);

  if (advisories.length === 0) {
    return null;
  }

  return {
    schema_version: 1,
    run_id: runId,
    generated_at: generatedAt,
    advisories,
    categories: classifyReviewAdvisoryCategories(advisories),
  };
}

export function buildReviewAdvisoryDispositionRecord(
  runId: string,
  advisoryCount: number,
  selected: ReviewAdvisoryDisposition | null,
  selectedAt: string | null,
): ReviewAdvisoryDispositionRecord {
  return {
    schema_version: 1,
    run_id: runId,
    advisory_count: advisoryCount,
    selected,
    selected_at: selectedAt,
    available_options: [...REVIEW_ADVISORY_DISPOSITIONS],
  };
}

export function readReviewAdvisoryDisposition(
  cwd: string,
): ReviewAdvisoryDispositionRecord | null {
  const parsed = readJsonObject(join(cwd, reviewAdvisoryDispositionPath()));
  if (!parsed) {
    return null;
  }

  const selected = typeof parsed.selected === 'string'
    && (REVIEW_ADVISORY_DISPOSITIONS as readonly string[]).includes(parsed.selected)
    ? parsed.selected as ReviewAdvisoryDisposition
    : parsed.selected === null
      ? null
      : null;
  const advisoryCount = typeof parsed.advisory_count === 'number'
    && Number.isInteger(parsed.advisory_count)
    && parsed.advisory_count >= 0
    ? parsed.advisory_count
    : 0;

  return {
    schema_version: 1,
    run_id: typeof parsed.run_id === 'string' ? parsed.run_id : '',
    advisory_count: advisoryCount,
    selected,
    selected_at: typeof parsed.selected_at === 'string' ? parsed.selected_at : null,
    available_options: [...REVIEW_ADVISORY_DISPOSITIONS],
  };
}

export function readReviewAdvisories(cwd: string): ReviewAdvisoriesRecord | null {
  const parsed = readJsonObject(join(cwd, reviewAdvisoriesPath()));
  if (!parsed || !Array.isArray(parsed.advisories)) {
    return null;
  }

  const advisories = dedupeAdvisories(parsed.advisories.filter((value): value is string => typeof value === 'string'));
  return {
    schema_version: 1,
    run_id: typeof parsed.run_id === 'string' ? parsed.run_id : '',
    generated_at: typeof parsed.generated_at === 'string' ? parsed.generated_at : '',
    advisories,
    categories: normalizeAdvisoryCategories(parsed.categories, advisories),
  };
}

export function reviewHasAdvisories(reviewStatus: StageStatus | null | undefined): boolean {
  return (reviewStatus?.advisory_count ?? 0) > 0;
}

export function effectiveReviewAdvisoryDisposition(
  cwd: string,
  reviewStatus: StageStatus | null | undefined,
  override: ReviewAdvisoryDisposition | null | undefined,
): ReviewAdvisoryDisposition | null {
  if (override) {
    return override;
  }

  if (reviewStatus?.advisory_disposition) {
    return reviewStatus.advisory_disposition;
  }

  return readReviewAdvisoryDisposition(cwd)?.selected ?? null;
}

export function persistReviewAdvisoryDisposition(
  cwd: string,
  record: ReviewAdvisoryDispositionRecord,
): void {
  const path = join(cwd, reviewAdvisoryDispositionPath());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
}

export function advisoryDispositionPermitsStage(
  stage: 'build' | 'qa' | 'ship' | 'closeout',
  disposition: ReviewAdvisoryDisposition | null,
): boolean {
  if (stage === 'build') {
    return disposition === 'fix_before_qa';
  }

  return disposition === 'continue_to_qa' || disposition === 'defer_to_follow_on';
}

export function requiredReviewAdvisoryDispositionError(
  stage: 'build' | 'qa' | 'ship' | 'closeout',
): string {
  if (stage === 'build') {
    return 'Review advisories require an explicit fix decision before build. Re-run /build with --review-advisory-disposition fix_before_qa.';
  }

  return `Review advisories require an explicit disposition before ${stage}. Re-run /${stage} with --review-advisory-disposition continue_to_qa or --review-advisory-disposition defer_to_follow_on, or run /build with --review-advisory-disposition fix_before_qa.`;
}
