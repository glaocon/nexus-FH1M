import * as fs from 'fs';
import * as path from 'path';
import {
  skillNameFromSourcePath,
  skillSourceCategoryForName,
  type SkillStructureCategory,
} from '../../lib/nexus/skill-structure';

export type SkillAnatomyCategory = 'root' | 'canonical' | 'alias' | 'support';
export type SkillAnatomyStatus = 'pass' | 'warn' | 'fail';

export type SkillAnatomyCriterionId =
  | 'trigger_conditions'
  | 'identity_overview'
  | 'workflow_steps'
  | 'output_contract'
  | 'verification_evidence'
  | 'safety_boundaries';

export type SkillAnatomyCriterion = {
  id: SkillAnatomyCriterionId;
  label: string;
  weight: number;
  why: string;
};

export type SkillAnatomyResult = {
  path: string;
  category: SkillAnatomyCategory;
  score: number;
  maxScore: number;
  status: SkillAnatomyStatus;
  passed: SkillAnatomyCriterion[];
  missing: SkillAnatomyCriterion[];
  recommendations: string[];
};

export const SUPPORT_SKILL_RUBRIC = {
  passScore: 10,
  warnScore: 7,
  maxScore: 10,
  criteria: [
    {
      id: 'trigger_conditions',
      label: 'Trigger conditions',
      weight: 2,
      why: 'Descriptions must tell agents when to load the skill, not just what it is.',
    },
    {
      id: 'identity_overview',
      label: 'Identity and overview',
      weight: 1,
      why: 'A skill needs a clear role or intent before the workflow starts.',
    },
    {
      id: 'workflow_steps',
      label: 'Workflow steps',
      weight: 2,
      why: 'Support skills should encode a process, not only reference prose.',
    },
    {
      id: 'output_contract',
      label: 'Output contract',
      weight: 2,
      why: 'Agents need to know what artifact, report, or handoff proves the skill ran.',
    },
    {
      id: 'verification_evidence',
      label: 'Verification evidence',
      weight: 2,
      why: 'Completion must require evidence such as tests, screenshots, reports, or status artifacts.',
    },
    {
      id: 'safety_boundaries',
      label: 'Safety boundaries',
      weight: 1,
      why: 'Support skills need explicit scope, ask-first, or do-not-touch rules.',
    },
  ] satisfies SkillAnatomyCriterion[],
} as const;

function anatomyCategoryFromStructure(category: SkillStructureCategory | null): SkillAnatomyCategory {
  if (category === 'safety') {
    return 'support';
  }
  return category ?? 'support';
}

export function classifySkillPath(filePath: string): SkillAnatomyCategory {
  const skillName = skillNameFromSourcePath(filePath);
  return anatomyCategoryFromStructure(skillSourceCategoryForName(skillName));
}

function frontmatterBlock(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? '';
}

function frontmatterDescription(content: string): string {
  const frontmatter = frontmatterBlock(content);
  const descriptionMatch = frontmatter.match(/^description:\s*(.*)$/m);
  if (!descriptionMatch) {
    return '';
  }

  const firstLine = descriptionMatch[1]?.trim() ?? '';
  const lines = frontmatter.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.startsWith('description:'));
  if (!firstLine || firstLine === '|' || firstLine === '>') {
    const body: string[] = [];
    for (const line of lines.slice(startIndex + 1)) {
      if (/^[A-Za-z0-9_-]+:\s*/.test(line)) {
        break;
      }
      if (line.trim()) {
        body.push(line.trim());
      }
    }
    return body.join(' ');
  }

  return firstLine.replace(/^['"]|['"]$/g, '');
}

function bodyContent(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function criterionPasses(id: SkillAnatomyCriterionId, content: string): boolean {
  const description = frontmatterDescription(content);
  const body = bodyContent(content);
  const haystack = `${description}\n${body}`;

  switch (id) {
    case 'trigger_conditions':
      return matchesAny(description, [
        /\buse when\b/i,
        /\buse for\b/i,
        /\bproactively suggest when\b/i,
        /\bwhen asked\b/i,
        /\bwhen the user\b/i,
      ]);
    case 'identity_overview':
      return /^#\s+\S+/m.test(body) && matchesAny(body, [
        /\byou are\b/i,
        /\boverview\b/i,
        /\bthis skill\b/i,
        /\bthis support skill\b/i,
        /\bpersistent\b/i,
      ]);
    case 'workflow_steps':
      return matchesAny(body, [
        /^##\s+(Setup|Instructions|Process|Workflow|Phases?|Mode Resolution|Operator Checklist|Arguments|Core .+ Patterns)\b/im,
        /^\s*\d+\.\s+\S+/m,
        /\bRun:\s*$/im,
        /\bFor each\b/i,
      ]);
    case 'output_contract':
      return matchesAny(body, [
        /^##\s+(Output|Output Structure|Artifact Contract|Completion Advisor|Report|Deliverables?)\b/im,
        /\bwrite(s)?\s+.+\.(json|md|markdown)\b/i,
        /\breport\b/i,
        /\bstatus\.json\b/i,
        /\bcompletion-advisor\.json\b/i,
      ]);
    case 'verification_evidence':
      return matchesAny(body, [
        /^##\s+(Verification|Verify|Evidence|QA|Validation)\b/im,
        /\bverify\b/i,
        /\bevidence\b/i,
        /\bscreenshot\b/i,
        /\btests?\s+pass\b/i,
        /\brun.+test/i,
        /\bbuild.+pass/i,
      ]);
    case 'safety_boundaries':
      return matchesAny(body, [
        /\bdo not\b/i,
        /\bdon't\b/i,
        /\bnever\b/i,
        /\bstop\b/i,
        /\baskuserquestion\b/i,
        /\bask first\b/i,
        /\bclean working tree\b/i,
        /\bdestructive\b/i,
        /\bscope\b/i,
      ]);
  }
}

function recommendationFor(criterion: SkillAnatomyCriterion): string {
  switch (criterion.id) {
    case 'trigger_conditions':
      return 'Add explicit "Use when..." trigger conditions to frontmatter description.';
    case 'identity_overview':
      return 'Add a clear H1 and 1-2 sentence role/overview near the top of the skill.';
    case 'workflow_steps':
      return 'Add ordered workflow steps or process phases agents can execute.';
    case 'output_contract':
      return 'Declare the expected report, artifact, status file, or handoff output.';
    case 'verification_evidence':
      return 'Add a verification/evidence section with concrete proof requirements.';
    case 'safety_boundaries':
      return 'Add scope limits, ask-first rules, or do-not-touch safety boundaries.';
  }
}

export function analyzeSkillAnatomy(input: {
  path: string;
  content: string;
  category?: SkillAnatomyCategory;
}): SkillAnatomyResult {
  const category = input.category ?? classifySkillPath(input.path);
  const criteria = [...SUPPORT_SKILL_RUBRIC.criteria];
  const passed = criteria.filter((criterion) => criterionPasses(criterion.id, input.content));
  const missing = criteria.filter((criterion) => !passed.includes(criterion));
  const score = passed.reduce((sum, criterion) => sum + criterion.weight, 0);
  const status: SkillAnatomyStatus = score >= SUPPORT_SKILL_RUBRIC.passScore
    ? 'pass'
    : score >= SUPPORT_SKILL_RUBRIC.warnScore
      ? 'warn'
      : 'fail';

  return {
    path: input.path,
    category,
    score,
    maxScore: SUPPORT_SKILL_RUBRIC.maxScore,
    status,
    passed,
    missing,
    recommendations: missing.map(recommendationFor),
  };
}

export function analyzeSkillFile(filePath: string, root = process.cwd()): SkillAnatomyResult {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  return analyzeSkillAnatomy({
    path: path.relative(root, fullPath) || filePath,
    content: fs.readFileSync(fullPath, 'utf-8'),
  });
}
