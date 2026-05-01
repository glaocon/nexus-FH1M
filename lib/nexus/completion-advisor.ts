import type {
  CompletionAdvisorActionKind,
  CompletionAdvisorActionRecord,
  CompletionAdvisorEvidenceSignalRecord,
  CompletionAdvisorRecord,
  DeployReadinessRecord,
  DeployResultRecord,
  PullRequestRecord,
  ReviewAdvisoryDisposition,
  StageStatus,
  VerificationMatrixRecord,
  InstalledSkillRecord,
  VerificationChecklistCategory,
} from './types';
import { discoverExternalInstalledSkills, rankExternalInstalledSkillsForAdvisor } from './external-skills';
import { readVerificationMatrix } from './verification-matrix';
import { shellQuotePosix } from './shell-quote';

const HIDDEN_COMPAT_ALIASES = ['/office-hours', '/autoplan', '/plan-ceo-review', '/plan-eng-review'] as const;
const HIDDEN_UTILITY_SKILLS = ['/careful', '/freeze', '/guard', '/unfreeze', '/nexus-upgrade'] as const;

function designBearing(designImpact: StageStatus['design_impact'] | VerificationMatrixRecord['design_impact'] | null | undefined): boolean {
  return (designImpact ?? 'none') !== 'none';
}

function action(
  id: string,
  kind: CompletionAdvisorActionKind,
  surface: string,
  invocation: string | null,
  label: string,
  description: string,
  recommended = false,
  visibilityReason: string | null = null,
  whyThisSkill: string | null = null,
  evidenceSignal: CompletionAdvisorEvidenceSignalRecord | null = null,
): CompletionAdvisorActionRecord {
  const fallbackSupportWhy = kind === 'support_skill' && visibilityReason
    ? `Use this because ${visibilityReason.charAt(0).toLowerCase()}${visibilityReason.slice(1)}`
    : null;
  const fallbackSupportEvidence: CompletionAdvisorEvidenceSignalRecord | null = kind === 'support_skill' && visibilityReason
    ? {
        kind: 'stage_status',
        summary: visibilityReason,
        source_paths: [],
        checklist_categories: [],
      }
    : null;

  return {
    id,
    kind,
    surface,
    invocation,
    label,
    description,
    recommended,
    visibility_reason: visibilityReason,
    why_this_skill: whyThisSkill ?? fallbackSupportWhy,
    evidence_signal: evidenceSignal ?? fallbackSupportEvidence,
  };
}

function stopAction(stage: StageStatus['stage']): CompletionAdvisorActionRecord {
  return action(
    `stop_after_${stage}`,
    'stop',
    'stop',
    null,
    'Stop here',
    'Do not advance yet. Keep the current artifacts as-is and decide on the next step later.',
    false,
    'Always available as the minimal non-advancing choice after a completed stage.',
  );
}

function suppressedSurfaces(): string[] {
  return [...HIDDEN_COMPAT_ALIASES, ...HIDDEN_UTILITY_SKILLS];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function deploySurfaceConfigured(deployReadiness: DeployReadinessRecord | null): boolean {
  if (!deployReadiness?.configured) return false;
  if (deployReadiness.platform === 'none') return false;
  if (deployReadiness.project_type === 'cli' || deployReadiness.project_type === 'library') return false;
  return Boolean(
    deployReadiness.production_url
    || deployReadiness.health_check
    || deployReadiness.deploy_workflow
    || deployReadiness.deploy_status_command,
  );
}

function canaryEvidenceRelevant(deployResult: DeployResultRecord | null): boolean {
  if (!deployResult || deployResult.merge_status !== 'merged') return false;
  if (deployResult.deploy_status === 'skipped') return false;
  return Boolean(deployResult.production_url);
}

function outcomeForStatus(status: Pick<StageStatus, 'state' | 'ready'>): CompletionAdvisorRecord['stage_outcome'] {
  if (status.state === 'refused') {
    return 'refused';
  }
  if (status.state === 'blocked' || status.ready === false) {
    return 'blocked';
  }
  return 'ready';
}

function renderChecklistBackedVisibilityReason(
  signal: VerificationMatrixRecord['support_skill_signals'][keyof VerificationMatrixRecord['support_skill_signals']],
): string | null {
  const baseReason = signal.reason ?? 'The verification matrix surfaced this support skill.';
  const rationale = signal.checklist_rationale ?? [];
  if (rationale.length === 0 || baseReason.includes('Checklist-backed rationale:')) {
    return baseReason;
  }

  const rendered = rationale
    .map((entry) => `${entry.category} ${entry.source_path} - ${entry.rationale}`)
    .join('; ');
  return `${baseReason} Checklist-backed rationale: ${rendered}`;
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function humanList(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '';
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function supportSkillWhyFromSignal(
  signal: VerificationMatrixRecord['support_skill_signals'][keyof VerificationMatrixRecord['support_skill_signals']],
): string | null {
  const categories = uniqueValues((signal.checklist_rationale ?? []).map((entry) => entry.category));
  if (categories.length === 0) {
    return signal.reason;
  }
  return `Use this because the verification matrix ties this run to the ${humanList(categories)} checklists.`;
}

function supportSkillEvidenceFromSignal(
  signal: VerificationMatrixRecord['support_skill_signals'][keyof VerificationMatrixRecord['support_skill_signals']],
): CompletionAdvisorEvidenceSignalRecord | null {
  const rationale = signal.checklist_rationale ?? [];
  if (rationale.length === 0) {
    return signal.reason
      ? {
          kind: 'verification_matrix',
          summary: signal.reason,
          source_paths: [],
          checklist_categories: [],
        }
      : null;
  }

  const checklistCategories = uniqueValues(rationale.map((entry) => entry.category)) as VerificationChecklistCategory[];
  const sourcePaths = uniqueValues(rationale.map((entry) => entry.source_path));
  return {
    kind: 'verification_matrix',
    summary: `Verification matrix surfaced ${humanList(checklistCategories)} checklist coverage for this recommendation.`,
    source_paths: sourcePaths,
    checklist_categories: checklistCategories,
  };
}

function suggestedSkillSignal(
  verificationMatrix: VerificationMatrixRecord | null | undefined,
  key: keyof VerificationMatrixRecord['support_skill_signals'],
): VerificationMatrixRecord['support_skill_signals'][typeof key] | null {
  const signal = verificationMatrix?.support_skill_signals?.[key];
  return signal?.suggested
    ? {
        ...signal,
        reason: renderChecklistBackedVisibilityReason(signal),
      }
    : null;
}

function reviewAdvisoryHasCategory(
  status: StageStatus,
  category: VerificationChecklistCategory,
): boolean {
  return (status.advisory_categories ?? []).includes(category);
}

function reviewAdvisoryFollowupSignal(
  status: StageStatus,
  verificationMatrix: VerificationMatrixRecord | null | undefined,
  key: keyof VerificationMatrixRecord['support_skill_signals'],
  category: VerificationChecklistCategory,
  fallbackReason: string,
): VerificationMatrixRecord['support_skill_signals'][typeof key] | null {
  if (!reviewAdvisoryHasCategory(status, category)) {
    return null;
  }

  const suggestedSignal = suggestedSkillSignal(verificationMatrix, key);
  if (suggestedSignal) {
    return suggestedSignal;
  }

  const checklist = verificationMatrix?.checklists?.[category];
  return {
    suggested: true,
    reason: fallbackReason,
    checklist_rationale: checklist
      ? [
          {
            category,
            source_path: checklist.source_path,
            rationale: checklist.rationale,
          },
        ]
      : [],
  };
}

function reviewAdvisoryEvidenceFromSignal(
  signal: VerificationMatrixRecord['support_skill_signals'][keyof VerificationMatrixRecord['support_skill_signals']],
  categories: VerificationChecklistCategory[],
): CompletionAdvisorEvidenceSignalRecord {
  const rationale = signal.checklist_rationale.filter((entry) => categories.includes(entry.category));
  return {
    kind: 'review_advisory',
    summary: `Review advisories matched ${humanList(categories)} follow-up categories.`,
    source_paths: uniqueValues(rationale.map((entry) => entry.source_path)),
    checklist_categories: categories,
  };
}

function baseAdvisor(
  status: StageStatus,
  generatedAt: string,
  summary: string,
  overrides: Partial<Omit<CompletionAdvisorRecord, 'schema_version' | 'run_id' | 'stage' | 'generated_at' | 'summary'>>,
): CompletionAdvisorRecord {
  return {
    schema_version: 1,
    run_id: status.run_id,
    stage: status.stage,
    generated_at: generatedAt,
    stage_outcome: outcomeForStatus(status),
    interaction_mode: 'summary_only',
    summary,
    requires_user_choice: false,
    choice_reason: null,
    default_action_id: null,
    primary_next_actions: [],
    alternative_next_actions: [],
    recommended_side_skills: [],
    recommended_external_skills: [],
    stop_action: null,
    project_setup_gaps: [],
    hidden_compat_aliases: [...HIDDEN_COMPAT_ALIASES],
    hidden_utility_skills: [...HIDDEN_UTILITY_SKILLS],
    suppressed_surfaces: suppressedSurfaces(),
    ...overrides,
  };
}

function advisorSurfaces(record: CompletionAdvisorRecord): string[] {
  return uniqueStrings([
    ...record.primary_next_actions.map((candidate) => candidate.surface),
    ...record.alternative_next_actions.map((candidate) => candidate.surface),
    ...record.recommended_side_skills.map((candidate) => candidate.surface),
    ...(record.recommended_external_skills ?? []).map((candidate) => candidate.surface),
    record.stop_action?.surface,
    ...record.suppressed_surfaces,
  ]);
}

export function attachExternalInstalledSkillRecommendations(
  record: CompletionAdvisorRecord,
  verificationMatrix: VerificationMatrixRecord | null = null,
  externalSkills: InstalledSkillRecord[] = [],
): CompletionAdvisorRecord {
  if (record.requires_user_choice || record.interaction_mode !== 'recommended_choice') {
    return record;
  }

  const ranked = rankExternalInstalledSkillsForAdvisor({
    stage: record.stage,
    verification_matrix: verificationMatrix,
    skills: externalSkills,
    existing_surfaces: advisorSurfaces(record),
    limit: 3,
  });
  if (ranked.length === 0) {
    return {
      ...record,
      recommended_external_skills: record.recommended_external_skills ?? [],
    };
  }

  return {
    ...record,
    recommended_external_skills: [
      ...(record.recommended_external_skills ?? []),
      ...ranked,
    ],
  };
}

export interface CompletionAdvisorWriteOptions {
  verificationMatrix?: VerificationMatrixRecord | null;
  externalSkills?: InstalledSkillRecord[];
  cwd?: string;
  home?: string;
}

export function buildFrameCompletionAdvisor(
  status: StageStatus,
  generatedAt: string,
): CompletionAdvisorRecord {
  const setupGaps: string[] = [];
  const sideSkills: CompletionAdvisorActionRecord[] = [];
  const primary = action(
    'run_plan',
    'canonical_stage',
    '/plan',
    '/plan',
    'Run `/plan`',
    'Turn framing into an execution-ready packet.',
    true,
    'Framing is complete and planning is the canonical next lifecycle step.',
  );
  if (designBearing(status.design_impact)) {
    sideSkills.push(
      action(
        'run_plan_design_review',
        'support_skill',
        '/plan-design-review',
        '/plan-design-review',
        'Run `/plan-design-review`',
        'Tighten the design contract before execution on a design-bearing run.',
        false,
        'The run is design-bearing and should tighten the design contract before execution.',
      ),
    );
  }
  if (status.design_contract_required && !status.design_contract_path) {
    setupGaps.push('Design work is in scope, but no design contract artifact is attached yet.');
    sideSkills.push(
      action(
        'run_design_consultation',
        'support_skill',
        '/design-consultation',
        '/design-consultation',
        'Run `/design-consultation`',
        'Create or tighten the design system before planning moves deeper into execution.',
        false,
        'Design work is in scope but no design contract artifact has been recorded yet.',
      ),
    );
  }

  if (!status.ready || status.state === 'blocked' || status.state === 'refused') {
    const interactionMode = sideSkills.length > 0 ? 'recommended_choice' : 'summary_only';
    return baseAdvisor(
      status,
      generatedAt,
      status.state === 'refused'
        ? 'Framing was refused. Resolve the refusal before trying again.'
        : 'Framing is blocked. Resolve the blocking condition before planning.',
      {
        interaction_mode: interactionMode,
        default_action_id: null,
        recommended_side_skills: sideSkills,
        stop_action: stopAction('frame'),
        project_setup_gaps: uniqueStrings([...setupGaps, ...status.errors]),
      },
    );
  }

  return baseAdvisor(
    status,
    generatedAt,
    'Framing is complete. The canonical next step is planning.',
    {
      interaction_mode: 'recommended_choice',
      default_action_id: primary.id,
      primary_next_actions: [primary],
      recommended_side_skills: sideSkills,
      stop_action: stopAction('frame'),
      project_setup_gaps: setupGaps,
    },
  );
}

export function buildPlanCompletionAdvisor(
  status: StageStatus,
  verificationMatrix: VerificationMatrixRecord | null,
  generatedAt: string,
): CompletionAdvisorRecord {
  const setupGaps: string[] = [];
  const primary = action(
    'run_handoff',
    'canonical_stage',
    '/handoff',
    '/handoff',
    'Run `/handoff`',
    'Freeze governed routing and provider intent before bounded execution.',
    true,
    'Planning is complete and governed handoff is the canonical next lifecycle step.',
  );
  const sideSkills = designBearing(verificationMatrix?.design_impact ?? status.design_impact)
    ? [
        action(
          'run_plan_design_review',
          'support_skill',
          '/plan-design-review',
          '/plan-design-review',
          'Run `/plan-design-review`',
          'Review the execution packet from a design perspective before handoff.',
          false,
          'The verification matrix marks this run as design-bearing.',
        ),
      ]
    : [];
  if (status.design_contract_required && !status.design_contract_path) {
    setupGaps.push('Design work is in scope, but no canonical design contract artifact is attached yet.');
    sideSkills.push(
      action(
        'run_design_consultation',
        'support_skill',
        '/design-consultation',
        '/design-consultation',
        'Run `/design-consultation`',
        'Create or tighten the design system so planning can attach a canonical design contract before handoff.',
        false,
        'Material design work requires a canonical plan design contract before handoff.',
      ),
    );
  }
  if (!verificationMatrix) {
    setupGaps.push('Verification matrix is missing from the planning artifacts.');
  }

  if (!status.ready || status.state === 'blocked' || status.state === 'refused') {
    const interactionMode = sideSkills.length > 0 ? 'recommended_choice' : 'summary_only';
    return baseAdvisor(
      status,
      generatedAt,
      status.state === 'refused'
        ? 'Planning was refused. Resolve the refusal before trying handoff.'
        : 'Planning is blocked. Resolve readiness and setup gaps before handoff.',
      {
        interaction_mode: interactionMode,
        default_action_id: null,
        recommended_side_skills: sideSkills,
        stop_action: stopAction('plan'),
        project_setup_gaps: uniqueStrings([...setupGaps, ...status.errors]),
      },
    );
  }

  return baseAdvisor(
    status,
    generatedAt,
    'Planning is complete. Governed routing is the next canonical step.',
    {
      interaction_mode: 'recommended_choice',
      default_action_id: primary.id,
      primary_next_actions: [primary],
      recommended_side_skills: sideSkills,
      stop_action: stopAction('plan'),
      project_setup_gaps: setupGaps,
    },
  );
}

export function buildHandoffCompletionAdvisor(
  status: StageStatus,
  generatedAt: string,
): CompletionAdvisorRecord {
  if (!status.ready || status.state === 'blocked' || status.state === 'refused') {
    const retry = action(
      'retry_handoff',
      'canonical_stage',
      '/handoff',
      '/handoff',
      'Retry `/handoff`',
      'Re-run governed route validation after resolving route, session, or provenance issues.',
      true,
      'Governed handoff is the only legal retry path before build can resume.',
    );

    return baseAdvisor(
      status,
      generatedAt,
      status.state === 'refused'
        ? 'Governed handoff was refused. Retry handoff after resolving the refusal.'
        : 'Governed handoff is blocked. Resolve route approval before build.',
      {
        default_action_id: retry.id,
        primary_next_actions: [retry],
        stop_action: stopAction('handoff'),
        project_setup_gaps: uniqueStrings(status.errors),
      },
    );
  }

  const primary = action(
    'run_build',
    'canonical_stage',
    '/build',
    '/build',
    'Run `/build`',
    'Execute the bounded governed implementation contract.',
    true,
    'Governed handoff is complete and build is the canonical continuation.',
  );

  return baseAdvisor(
    status,
    generatedAt,
    'Governed handoff is complete. Bounded implementation is the next step.',
    {
      default_action_id: primary.id,
      primary_next_actions: [primary],
    },
  );
}

export function buildBuildCompletionAdvisor(
  status: StageStatus,
  verificationMatrix: VerificationMatrixRecord | null,
  generatedAt: string,
): CompletionAdvisorRecord {
  if (!status.ready) {
    const recoverySurface = status.errors.some((error) =>
      /(handoff|route|validation|stale)/i.test(error)
    ) ? '/handoff' : '/investigate';
    const recovery = action(
      recoverySurface === '/handoff' ? 'refresh_handoff' : 'run_investigate',
      recoverySurface === '/handoff' ? 'canonical_stage' : 'support_skill',
      recoverySurface,
      recoverySurface,
      recoverySurface === '/handoff' ? 'Refresh `/handoff`' : 'Run `/investigate`',
      recoverySurface === '/handoff'
        ? 'Refresh governed routing before retrying the build.'
        : 'Investigate the blocking condition before retrying execution.',
      true,
      recoverySurface === '/handoff'
        ? 'The blocking errors point at route or handoff provenance problems.'
        : 'The blocking errors need investigation before another bounded build attempt.',
    );

    return baseAdvisor(
      status,
      generatedAt,
      'Build is not ready to advance. Resolve the blocking condition before review.',
      {
        stage_outcome: 'blocked',
        default_action_id: recovery.id,
        primary_next_actions: [recovery],
      },
    );
  }

  const primary = action(
    'run_review',
    'canonical_stage',
    '/review',
    '/review',
    'Run `/review`',
    'Persist the formal audit set before moving deeper into the governed tail.',
    true,
    'Build completed successfully and review is the canonical next stage.',
  );
  const sideSkills: CompletionAdvisorActionRecord[] = [];
  const designReviewSignal = suggestedSkillSignal(verificationMatrix, 'design_review');
  const browseSignal = suggestedSkillSignal(verificationMatrix, 'browse');
  if (designReviewSignal) {
    sideSkills.push(
      action(
        'run_design_review',
        'support_skill',
        '/design-review',
        '/design-review',
        'Run `/design-review`',
        'Do a focused visual audit on a design-bearing implementation before formal review.',
        false,
        designReviewSignal.reason,
        supportSkillWhyFromSignal(designReviewSignal),
        supportSkillEvidenceFromSignal(designReviewSignal),
      ),
    );
  }
  if (browseSignal) {
    sideSkills.push(
      action(
        'run_browse',
        'support_skill',
        '/browse',
        '/browse',
        'Run `/browse`',
        'Check the browser-facing surface directly before the governed audit.',
        false,
        browseSignal.reason,
        supportSkillWhyFromSignal(browseSignal),
        supportSkillEvidenceFromSignal(browseSignal),
      ),
    );
  }

  return baseAdvisor(
    status,
    generatedAt,
    'Build is ready. Formal review is the canonical next stage.',
    {
      interaction_mode: 'recommended_choice',
      default_action_id: primary.id,
      primary_next_actions: [primary],
      recommended_side_skills: sideSkills,
      stop_action: stopAction('build'),
    },
  );
}

function reviewDispositionActions(): CompletionAdvisorActionRecord[] {
  return [
    action(
      'fix_before_qa',
      'disposition',
      '/build',
      '/build --review-advisory-disposition fix_before_qa',
      'Fix advisories before QA',
      'Run a bounded fix cycle now, then return through `/review` before QA.',
      true,
      'Use this when you want to tighten non-blocking findings before formal QA.',
    ),
    action(
      'continue_to_qa',
      'disposition',
      '/qa',
      '/qa --review-advisory-disposition continue_to_qa',
      'Continue to `/qa`',
      'Carry the advisories forward as non-blocking context and proceed into QA.',
      false,
      'Use this when the advisories are acknowledged but not worth fixing before QA.',
    ),
    action(
      'defer_to_follow_on',
      'disposition',
      '/qa',
      '/qa --review-advisory-disposition defer_to_follow_on',
      'Defer to follow-on work',
      'Keep the mainline moving and record the advisories for `/ship`, `/closeout`, and follow-on work.',
      false,
      'Use this when the advisories should stay visible but move out of the critical path.',
    ),
  ];
}

export function buildReviewCompletionAdvisor(
  status: StageStatus,
  verificationMatrix: VerificationMatrixRecord | null,
  generatedAt: string,
  externalSkills: InstalledSkillRecord[] = [],
): CompletionAdvisorRecord {
  if (status.gate_decision === 'fail') {
    const primary = action(
      'run_build_fix_cycle',
      'canonical_stage',
      '/build',
      '/build',
      'Run `/build`',
      'The review failed. A bounded fix cycle is required before QA.',
      true,
      'A failing review cannot advance until the bounded fix cycle is complete.',
    );
    return baseAdvisor(
      status,
      generatedAt,
      'Review failed. The canonical next step is a bounded fix cycle through `/build`.',
      {
        stage_outcome: 'requires_choice',
        interaction_mode: 'required_choice',
        requires_user_choice: true,
        choice_reason: 'review failed',
        default_action_id: primary.id,
        primary_next_actions: [primary],
      },
    );
  }

  if ((status.advisory_count ?? 0) > 0 && !status.advisory_disposition) {
    const actions = reviewDispositionActions();
    const sideSkills: CompletionAdvisorActionRecord[] = [];
    const simplifySignal = reviewAdvisoryFollowupSignal(
      status,
      verificationMatrix,
      'simplify',
      'maintainability',
      'Review advisories include maintainability or complexity cleanup work.',
    );
    const benchmarkSignal = reviewAdvisoryFollowupSignal(
      status,
      verificationMatrix,
      'benchmark',
      'performance',
      'Review advisories include performance risk that needs measurement before optimization.',
    );
    const csoSignal = reviewAdvisoryFollowupSignal(
      status,
      verificationMatrix,
      'cso',
      'security',
      'Review advisories include security or trust-boundary hardening work.',
    );

    if (simplifySignal) {
      sideSkills.push(
        action(
          'run_simplify',
          'support_skill',
          '/simplify',
          '/simplify',
          'Run `/simplify`',
          'Run a behavior-preserving simplification pass on complexity or maintainability advisories.',
          false,
          simplifySignal.reason,
          supportSkillWhyFromSignal(simplifySignal),
          reviewAdvisoryEvidenceFromSignal(simplifySignal, ['maintainability']),
        ),
      );
    }

    if (benchmarkSignal) {
      sideSkills.push(
        action(
          'run_benchmark',
          'support_skill',
          '/benchmark',
          '/benchmark',
          'Run `/benchmark`',
          'Attach performance measurements for review advisories that mention latency, bundle, query, or load risk.',
          false,
          benchmarkSignal.reason,
          supportSkillWhyFromSignal(benchmarkSignal),
          reviewAdvisoryEvidenceFromSignal(benchmarkSignal, ['performance']),
        ),
      );
    }

    if (csoSignal) {
      sideSkills.push(
        action(
          'run_cso',
          'support_skill',
          '/cso',
          '/cso',
          'Run `/cso`',
          'Run focused hardening for review advisories that mention auth, permission, secret, or trust-boundary risk.',
          false,
          csoSignal.reason,
          supportSkillWhyFromSignal(csoSignal),
          reviewAdvisoryEvidenceFromSignal(csoSignal, ['security']),
        ),
      );
    }

    return baseAdvisor(
      status,
      generatedAt,
      'Review passed with advisories. Choose whether to fix them now or carry them forward.',
      {
        stage_outcome: 'requires_choice',
        interaction_mode: 'required_choice',
        requires_user_choice: true,
        choice_reason: 'review advisories require an explicit disposition',
        default_action_id: actions[0]?.id ?? null,
        primary_next_actions: actions,
        recommended_side_skills: sideSkills,
      },
    );
  }

  const primary = action(
    'run_qa',
    'canonical_stage',
    '/qa',
    '/qa',
    'Run `/qa`',
    'Record governed QA validation before the release gate.',
    true,
    'Review passed cleanly and QA is the recommended governed continuation.',
  );
  const alternatives = [
    action(
      'run_ship',
      'canonical_stage',
      '/ship',
      '/ship',
      'Run `/ship`',
      'Skip directly to the release gate when that is the intended governed path.',
      false,
      'QA is usually next, but the lifecycle still permits an intentional direct move to ship.',
    ),
  ];
  const sideSkills: CompletionAdvisorActionRecord[] = [];
  const benchmarkSignal = suggestedSkillSignal(verificationMatrix, 'benchmark');
  const designReviewSignal = suggestedSkillSignal(verificationMatrix, 'design_review');
  const csoSignal = suggestedSkillSignal(verificationMatrix, 'cso');
  if (benchmarkSignal) {
    sideSkills.push(
      action(
        'run_benchmark',
        'support_skill',
        '/benchmark',
        '/benchmark',
        'Run `/benchmark`',
        'Attach performance evidence before the release gate if this change is perf-sensitive.',
        false,
        benchmarkSignal.reason,
        supportSkillWhyFromSignal(benchmarkSignal),
        supportSkillEvidenceFromSignal(benchmarkSignal),
      ),
    );
  }
  if (designReviewSignal) {
    sideSkills.push(
      action(
        'run_design_review',
        'support_skill',
        '/design-review',
        '/design-review',
        'Run `/design-review`',
        'Polish the visual result before QA on a design-bearing run.',
        false,
        designReviewSignal.reason,
        supportSkillWhyFromSignal(designReviewSignal),
        supportSkillEvidenceFromSignal(designReviewSignal),
      ),
    );
  }
  if (csoSignal) {
    sideSkills.push(
      action(
        'run_cso',
        'support_skill',
        '/cso',
        '/cso',
        'Run `/cso`',
        'Audit security-sensitive changes before the release gate advances.',
        false,
        csoSignal.reason,
        supportSkillWhyFromSignal(csoSignal),
        supportSkillEvidenceFromSignal(csoSignal),
      ),
    );
  }

  return attachExternalInstalledSkillRecommendations(baseAdvisor(
    status,
    generatedAt,
    'Review passed cleanly. QA is the recommended governed next step.',
    {
      interaction_mode: 'recommended_choice',
      default_action_id: primary.id,
      primary_next_actions: [primary],
      alternative_next_actions: alternatives,
      recommended_side_skills: sideSkills,
      stop_action: stopAction('review'),
    },
  ), verificationMatrix, externalSkills);
}

export function buildQaCompletionAdvisor(
  status: StageStatus,
  verificationMatrix: VerificationMatrixRecord | null,
  generatedAt: string,
): CompletionAdvisorRecord {
  if (!status.ready) {
    if (status.state === 'blocked' || status.state === 'refused') {
      const primary = action(
        'retry_qa',
        'canonical_stage',
        '/qa',
        '/qa',
        'Retry `/qa`',
        'QA did not record a valid validation result. Retry QA after resolving the runtime or routing blocker.',
        true,
        'Blocked/refused QA is a runtime validation failure, not proof that the implementation needs a build fix cycle.',
      );
      return baseAdvisor(
        status,
        generatedAt,
        'QA did not complete. Retry `/qa` after resolving the blocking condition.',
        {
          stage_outcome: 'requires_choice',
          interaction_mode: 'required_choice',
          requires_user_choice: true,
          choice_reason: 'qa blocked',
          default_action_id: primary.id,
          primary_next_actions: [primary],
        },
      );
    }

    const primary = action(
      'run_build_fix_cycle',
      'canonical_stage',
      '/build',
      '/build',
      'Run `/build`',
      'QA failed. A bounded fix cycle is required before ship.',
      true,
      'A failing QA result cannot advance until the bounded fix cycle is complete.',
    );
    return baseAdvisor(
      status,
      generatedAt,
      'QA failed. The canonical next step is a fix cycle through `/build`.',
      {
        stage_outcome: 'requires_choice',
        interaction_mode: 'required_choice',
        requires_user_choice: true,
        choice_reason: 'qa failed',
        default_action_id: primary.id,
        primary_next_actions: [primary],
      },
    );
  }

  const primary = action(
    'run_ship',
    'canonical_stage',
    '/ship',
    '/ship',
    'Run `/ship`',
    'Record the release-gate decision and PR/deploy handoff.',
    true,
    'QA passed and ship is the canonical next governed step.',
  );
  const sideSkills: CompletionAdvisorActionRecord[] = [];
  const benchmarkSignal = suggestedSkillSignal(verificationMatrix, 'benchmark');
  const designReviewSignal = suggestedSkillSignal(verificationMatrix, 'design_review');
  const browseSignal = suggestedSkillSignal(verificationMatrix, 'browse');
  const connectChromeSignal = suggestedSkillSignal(verificationMatrix, 'connect_chrome');
  const setupBrowserCookiesSignal = suggestedSkillSignal(verificationMatrix, 'setup_browser_cookies');
  const csoSignal = suggestedSkillSignal(verificationMatrix, 'cso');
  if (benchmarkSignal) {
    sideSkills.push(
      action(
        'run_benchmark',
        'support_skill',
        '/benchmark',
        '/benchmark',
        'Run `/benchmark`',
        'Attach performance evidence before the release gate.',
        false,
        benchmarkSignal.reason,
        supportSkillWhyFromSignal(benchmarkSignal),
        supportSkillEvidenceFromSignal(benchmarkSignal),
      ),
    );
  }
  if (designReviewSignal) {
    sideSkills.push(
      action(
        'run_design_review',
        'support_skill',
        '/design-review',
        '/design-review',
        'Run `/design-review`',
        'Audit the visual result after QA on a design-bearing run.',
        false,
        designReviewSignal.reason,
        supportSkillWhyFromSignal(designReviewSignal),
        supportSkillEvidenceFromSignal(designReviewSignal),
      ),
    );
  }
  if (browseSignal) {
    sideSkills.push(
      action(
        'run_browse',
        'support_skill',
        '/browse',
        '/browse',
        'Run `/browse`',
        'Use the browser to verify the shipped UI path directly.',
        false,
        browseSignal.reason,
        supportSkillWhyFromSignal(browseSignal),
        supportSkillEvidenceFromSignal(browseSignal),
      ),
    );
  }
  if (connectChromeSignal) {
    sideSkills.push(
      action(
        'run_connect_chrome',
        'support_skill',
        '/connect-chrome',
        '/connect-chrome',
        'Run `/connect-chrome`',
        'Launch a real browser session for live verification instead of relying only on headless checks.',
        false,
        connectChromeSignal.reason,
        supportSkillWhyFromSignal(connectChromeSignal),
        supportSkillEvidenceFromSignal(connectChromeSignal),
      ),
    );
  }
  if (setupBrowserCookiesSignal) {
    sideSkills.push(
      action(
        'run_setup_browser_cookies',
        'support_skill',
        '/setup-browser-cookies',
        '/setup-browser-cookies',
        'Run `/setup-browser-cookies`',
        'Import authenticated browser sessions before testing protected flows.',
        false,
        setupBrowserCookiesSignal.reason,
        supportSkillWhyFromSignal(setupBrowserCookiesSignal),
        supportSkillEvidenceFromSignal(setupBrowserCookiesSignal),
      ),
    );
  }
  if (csoSignal) {
    sideSkills.push(
      action(
        'run_cso',
        'support_skill',
        '/cso',
        '/cso',
        'Run `/cso`',
        'Audit security-sensitive changes before the release gate advances.',
        false,
        csoSignal.reason,
        supportSkillWhyFromSignal(csoSignal),
        supportSkillEvidenceFromSignal(csoSignal),
      ),
    );
  }

  return baseAdvisor(
    status,
    generatedAt,
    'QA is complete. Ship is the next governed step.',
    {
      interaction_mode: 'recommended_choice',
      default_action_id: primary.id,
      primary_next_actions: [primary],
      recommended_side_skills: sideSkills,
      stop_action: stopAction('qa'),
    },
  );
}

export function buildShipCompletionAdvisor(
  status: StageStatus,
  verificationMatrix: VerificationMatrixRecord | null,
  deployReadiness: DeployReadinessRecord | null,
  generatedAt: string,
  pullRequest: PullRequestRecord | null = status.pull_request ?? null,
): CompletionAdvisorRecord {
  const setupGaps: string[] = [];
  const deployConfigured = deploySurfaceConfigured(deployReadiness);
  const primary = [
    action(
      'run_land',
      'support_skill',
      '/land',
      '/land',
      'Run `/land`',
      'Merge the PR from the ship handoff without assuming deployment.',
      true,
      'Landing the PR is the clearest next operational step after ship records merge readiness.',
    ),
    action(
      'run_land_and_deploy',
      'support_skill',
      '/land-and-deploy',
      '/land-and-deploy',
      'Run `/land-and-deploy`',
      'Merge the PR and continue into deployment verification when this project has a production surface.',
      false,
      deployConfigured
        ? 'The deploy contract is configured, so the combined land-and-deploy shortcut is available.'
        : 'Available as a shortcut, but use `/land` for merge-only projects or configure deploy first.',
    ),
    action(
      'run_closeout_after_manual_landing',
      'canonical_stage',
      '/closeout',
      '/closeout',
      'Run `/closeout` after manual landing',
      'Conclude the governed run if the PR has already been merged outside Nexus.',
      false,
      'Closeout remains available when landing was handled manually or intentionally deferred.',
    ),
  ];
  const sideSkills: CompletionAdvisorActionRecord[] = [
    action(
      'run_document_release',
      'support_skill',
      '/document-release',
      '/document-release',
      'Run `/document-release`',
      'Sync release notes and docs to the shipped surface.',
      false,
      'Release hygiene often continues immediately after ship records the gate.',
    ),
  ];
  if (!deployReadiness?.configured && verificationMatrix?.obligations.ship.deploy_readiness_required !== false) {
    setupGaps.push('Deploy contract is not configured for the primary surface yet.');
    sideSkills.unshift(
      action(
        'run_setup_deploy',
        'support_skill',
        '/setup-deploy',
        '/setup-deploy',
        'Run `/setup-deploy`',
        'Author the canonical deploy contract before landing and deployment.',
        false,
        'Landing should not rely on inferred deploy behavior when the primary deploy contract is still missing.',
      ),
    );
  }
  if (deployConfigured) {
    sideSkills.push(
      action(
        'run_deploy_after_land',
        'support_skill',
        '/deploy',
        '/deploy',
        'Run `/deploy` after `/land`',
        'Verify deployment after the PR has landed.',
        false,
        'The deploy contract is configured, but deployment should run after the PR is landed.',
      ),
    );
  }

  if (!status.ready || status.state === 'blocked' || status.state === 'refused') {
    if (pullRequest?.status === 'push_required') {
      const pushCommand = pullRequest.push_command ?? `git push -u origin ${shellQuotePosix(pullRequest.head_branch ?? 'HEAD')}`;
      const pushAction = action(
        'push_branch',
        'manual_command',
        'git push',
        pushCommand,
        'Push branch',
        `Run \`${pushCommand}\`, then rerun \`/ship\` so Nexus can create or reuse the PR handoff.`,
        true,
        pullRequest.reason ?? 'The release gate passed, but GitHub cannot create a PR until the head branch exists remotely.',
        null,
        {
          kind: 'stage_status',
          summary: pullRequest.reason ?? 'Ship is waiting for the branch to be pushed before PR creation.',
          source_paths: ['.planning/current/ship/pull-request.json'],
          checklist_categories: [],
        },
      );
      const rerunShip = action(
        'rerun_ship_after_push',
        'canonical_stage',
        '/ship',
        '/ship',
        'Rerun `/ship` after pushing',
        'Re-record ship after the branch is remote so the PR handoff can be created and closeout can proceed.',
        false,
        'The previous ship pass recorded the release gate but could not complete the PR handoff.',
      );

      return baseAdvisor(
        status,
        generatedAt,
        'Ship recorded the release gate, but the branch must be pushed before PR handoff and closeout.',
        {
          interaction_mode: 'required_choice',
          default_action_id: pushAction.id,
          primary_next_actions: [pushAction, rerunShip],
          stop_action: stopAction('ship'),
          project_setup_gaps: uniqueStrings([...setupGaps, ...status.errors]),
        },
      );
    }

    return baseAdvisor(
      status,
      generatedAt,
      status.state === 'refused'
        ? 'Ship was refused. Resolve the refusal before trying to record the release gate again.'
        : 'Ship is blocked. Resolve the release-gate blockers before closeout or landing.',
      {
        interaction_mode: 'summary_only',
        default_action_id: null,
        stop_action: stopAction('ship'),
        project_setup_gaps: uniqueStrings([...setupGaps, ...status.errors]),
      },
    );
  }

  return baseAdvisor(
    status,
    generatedAt,
    'Ship recorded the release gate. Close out the governed run or move into landing and deployment.',
    {
      interaction_mode: 'recommended_choice',
      default_action_id: primary[0]?.id ?? null,
      primary_next_actions: primary,
      recommended_side_skills: sideSkills,
      stop_action: stopAction('ship'),
      project_setup_gaps: setupGaps,
    },
  );
}

export function buildCloseoutCompletionAdvisor(
  status: StageStatus,
  shipPullRequest: PullRequestRecord | null,
  deployResult: DeployResultRecord | null,
  documentationSynced: boolean,
  canaryAttached: boolean,
  generatedAt: string,
): CompletionAdvisorRecord {
  if (!status.ready || status.state === 'blocked' || status.state === 'refused') {
    return baseAdvisor(
      status,
      generatedAt,
      status.state === 'refused'
        ? 'Closeout was refused. Resolve the refusal before concluding the governed run.'
        : 'Closeout is blocked. Resolve archive or provenance issues before concluding the run.',
      {
        interaction_mode: 'summary_only',
        default_action_id: null,
        stop_action: stopAction('closeout'),
        project_setup_gaps: uniqueStrings(status.errors),
      },
    );
  }

  const primary = action(
    'run_discover',
    'canonical_stage',
    '/discover',
    '/discover',
    'Run `/discover`',
    'Start the next governed run from the archived closeout context.',
    true,
    'Closeout completed successfully and a fresh discover is the canonical way to start the next governed run.',
  );
  const sideSkills: CompletionAdvisorActionRecord[] = [];
  if (shipPullRequest?.status === 'created' || shipPullRequest?.status === 'reused') {
    if (!deployResult || deployResult.merge_status === 'pending') {
      sideSkills.push(
        action(
          'run_land',
          'support_skill',
          '/land',
          '/land',
          'Run `/land`',
          'Use the ship handoff to merge the PR without assuming deployment.',
          false,
          'Landing is still pending for the shipped PR handoff.',
        ),
        action(
          'run_land_and_deploy',
          'support_skill',
          '/land-and-deploy',
          '/land-and-deploy',
          'Run `/land-and-deploy`',
          'Use the combined landing and deployment shortcut when the project has a deploy surface.',
          false,
          'Landing is still pending and a combined land/deploy flow remains available.',
        ),
      );
    }
  }
  if (deployResult?.merge_status === 'merged' && deployResult.deploy_status === 'skipped') {
    sideSkills.push(
      action(
        'run_deploy',
        'support_skill',
        '/deploy',
        '/deploy',
        'Run `/deploy` if needed',
        'Deploy and verify a landed change only when this project has a production surface.',
        false,
        'The PR is merged and deployment was skipped; deploy remains optional and project-dependent.',
      ),
    );
  }
  if (canaryEvidenceRelevant(deployResult) && !canaryAttached) {
    sideSkills.push(
      action(
        'run_canary',
        'support_skill',
        '/canary',
        '/canary',
        'Run `/canary`',
        'Add post-deploy health evidence after landing the change.',
        false,
        'The change is landed, but post-deploy canary evidence has not been attached yet.',
      ),
    );
  }
  sideSkills.push(
    action(
      'run_retro',
      'support_skill',
      '/retro',
      '/retro',
      'Run `/retro`',
      'Capture retrospective findings from this completed run.',
      false,
      'This run is complete and ready for retrospective capture.',
    ),
    action(
      'run_learn',
      'support_skill',
      '/learn',
      '/learn',
      'Run `/learn`',
      'Review or export durable learnings from this run.',
      false,
      'The canonical learnings have been written and can now be reviewed or exported.',
    ),
  );
  if (!documentationSynced) {
    sideSkills.push(
      action(
        'run_document_release',
        'support_skill',
        '/document-release',
        '/document-release',
        'Run `/document-release`',
        'Sync docs to match what was just shipped before the next cycle starts.',
        false,
        'Documentation has not yet been synchronized for this completed run.',
      ),
    );
  }

  return baseAdvisor(
    status,
    generatedAt,
    'Closeout is complete. Start the next run or continue with follow-on work from the archived context.',
    {
      interaction_mode: 'recommended_choice',
      default_action_id: primary.id,
      primary_next_actions: [primary],
      recommended_side_skills: sideSkills,
      stop_action: stopAction('closeout'),
    },
  );
}

export function buildCompletionAdvisorWrite(
  record: CompletionAdvisorRecord,
  options: CompletionAdvisorWriteOptions = {},
): { path: string; content: string } {
  const cwd = options.cwd ?? process.env.NEXUS_PROJECT_CWD ?? process.cwd();
  const verificationMatrix = options.verificationMatrix ?? readVerificationMatrix(cwd);
  const externalSkills = options.externalSkills ?? discoverExternalInstalledSkills({
    cwd,
    home: options.home,
  });
  const enriched = attachExternalInstalledSkillRecommendations(record, verificationMatrix, externalSkills);
  Object.assign(record, enriched);
  return {
    path: `.planning/current/${record.stage}/completion-advisor.json`,
    content: JSON.stringify(record, null, 2) + '\n',
  };
}

export function buildStageCompletionAdvisor(
  status: StageStatus,
  generatedAt: string,
  options: {
    verification_matrix?: VerificationMatrixRecord | null;
    deploy_readiness?: DeployReadinessRecord | null;
    ship_pull_request?: PullRequestRecord | null;
    deploy_result?: DeployResultRecord | null;
    documentation_synced?: boolean;
    canary_attached?: boolean;
  } = {},
): CompletionAdvisorRecord {
  switch (status.stage) {
    case 'frame':
      return buildFrameCompletionAdvisor(status, generatedAt);
    case 'plan':
      return buildPlanCompletionAdvisor(status, options.verification_matrix ?? null, generatedAt);
    case 'handoff':
      return buildHandoffCompletionAdvisor(status, generatedAt);
    case 'build':
      return buildBuildCompletionAdvisor(status, options.verification_matrix ?? null, generatedAt);
    case 'review':
      return buildReviewCompletionAdvisor(status, options.verification_matrix ?? null, generatedAt);
    case 'qa':
      return buildQaCompletionAdvisor(status, options.verification_matrix ?? null, generatedAt);
    case 'ship':
      return buildShipCompletionAdvisor(
        status,
        options.verification_matrix ?? null,
        options.deploy_readiness ?? null,
        generatedAt,
      );
    case 'closeout':
      return buildCloseoutCompletionAdvisor(
        status,
        options.ship_pull_request ?? null,
        options.deploy_result ?? null,
        options.documentation_synced ?? false,
        options.canary_attached ?? false,
        generatedAt,
      );
    case 'discover':
      return baseAdvisor(status, generatedAt, 'Discovery completed.', {});
  }
}

export function reviewDispositionInvocation(
  disposition: ReviewAdvisoryDisposition,
): string {
  switch (disposition) {
    case 'fix_before_qa':
      return '/build --review-advisory-disposition fix_before_qa';
    case 'continue_to_qa':
      return '/qa --review-advisory-disposition continue_to_qa';
    case 'defer_to_follow_on':
      return '/qa --review-advisory-disposition defer_to_follow_on';
  }
}
