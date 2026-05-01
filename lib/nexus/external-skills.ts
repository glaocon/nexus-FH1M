import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { CANONICAL_COMMANDS, type CanonicalCommandId, type CompletionAdvisorActionRecord, type InstalledSkillNamespace, type InstalledSkillRecord, type VerificationChecklistCategory, type VerificationMatrixRecord } from './types';

const NEXUS_SUPPORT_SKILLS = new Set([
  'benchmark',
  'browse',
  'canary',
  'careful',
  'codex',
  'connect-chrome',
  'cso',
  'design-consultation',
  'design-html',
  'design-review',
  'design-shotgun',
  'document-release',
  'freeze',
  'guard',
  'investigate',
  'deploy',
  'land',
  'land-and-deploy',
  'learn',
  'nexus-upgrade',
  'plan-design-review',
  'qa-only',
  'retro',
  'setup-browser-cookies',
  'setup-deploy',
  'simplify',
  'unfreeze',
]);

const CANONICAL_COMMAND_SET = new Set<string>(CANONICAL_COMMANDS);

const STAGE_INTENT_TAGS: Record<CanonicalCommandId, string[]> = {
  discover: ['discovery', 'customer-research', 'problem', 'market', 'opportunity', 'interview', 'persona'],
  frame: ['framing', 'scope', 'positioning', 'requirements', 'business-case', 'product-strategy'],
  plan: ['planning', 'architecture', 'stories', 'breakdown', 'risk', 'security', 'roadmap', 'prioritization'],
  handoff: ['handoff', 'routing', 'provenance'],
  build: ['implementation', 'debugging', 'code', 'frontend', 'backend'],
  review: ['code-review', 'audit', 'security', 'design-review', 'performance', 'quality', 'maintainability', 'simplification'],
  qa: ['qa', 'browser', 'testing', 'performance', 'accessibility', 'auth'],
  ship: ['release', 'docs', 'deploy', 'governance'],
  closeout: ['retro', 'learning', 'documentation', 'follow-on'],
};

const TAG_KEYWORDS: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: 'discovery', patterns: [/discover/i, /research/i, /interview/i, /jobs?[- ]to[- ]be[- ]done/i] },
  { tag: 'customer-research', patterns: [/customer/i, /persona/i, /journey/i, /jobs?[- ]to[- ]be[- ]done/i] },
  { tag: 'problem', patterns: [/problem/i, /hypothesis/i] },
  { tag: 'market', patterns: [/market/i, /competitor/i, /pestel/i, /tam/i] },
  { tag: 'opportunity', patterns: [/opportunit/i, /solution tree/i] },
  { tag: 'framing', patterns: [/fram/i, /scope/i, /canvas/i] },
  { tag: 'positioning', patterns: [/position/i, /brand/i] },
  { tag: 'requirements', patterns: [/requirement/i, /prd/i, /story/i] },
  { tag: 'planning', patterns: [/plan/i, /roadmap/i, /prioriti/i] },
  { tag: 'architecture', patterns: [/architect/i, /system/i, /technical/i] },
  { tag: 'stories', patterns: [/story/i, /epic/i, /mapping/i] },
  { tag: 'breakdown', patterns: [/breakdown/i, /split/i, /decompos/i] },
  { tag: 'risk', patterns: [/risk/i, /threat/i] },
  { tag: 'security', patterns: [/security/i, /auth/i, /permission/i, /secret/i, /threat/i, /cso/i] },
  { tag: 'code-review', patterns: [/code review/i, /\breview\b/i] },
  { tag: 'audit', patterns: [/audit/i, /quality/i, /check/i] },
  { tag: 'maintainability', patterns: [/maintain/i, /readab/i, /complex/i, /dead code/i, /unused/i, /duplication/i] },
  { tag: 'simplification', patterns: [/simplif/i, /refactor/i, /clarity/i, /cleanup/i] },
  { tag: 'design', patterns: [/design/i, /visual/i, /brand/i, /ux/i, /ui/i] },
  { tag: 'design-review', patterns: [/design review/i, /visual audit/i, /brand audit/i, /ux review/i] },
  { tag: 'performance', patterns: [/perf/i, /benchmark/i, /latency/i, /load/i] },
  { tag: 'qa', patterns: [/\bqa\b/i, /test/i, /validation/i] },
  { tag: 'browser', patterns: [/browser/i, /chrome/i, /playwright/i, /web/i] },
  { tag: 'accessibility', patterns: [/accessib/i, /\ba11y\b/i] },
  { tag: 'auth', patterns: [/auth/i, /cookie/i, /login/i, /session/i] },
  { tag: 'release', patterns: [/release/i, /ship/i, /changelog/i] },
  { tag: 'docs', patterns: [/docs?/i, /document/i] },
  { tag: 'deploy', patterns: [/deploy/i, /canary/i, /production/i] },
  { tag: 'retro', patterns: [/retro/i, /retrospective/i] },
  { tag: 'learning', patterns: [/learn/i, /memory/i] },
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);
const CHECKLIST_TAGS = new Set<VerificationChecklistCategory>([
  'testing',
  'security',
  'maintainability',
  'performance',
  'accessibility',
  'design',
]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeName(name: string): string {
  return name.trim().replace(/^\/+/, '').toLowerCase();
}

function commandSurface(name: string): string {
  return `/${normalizeName(name)}`;
}

function stripNexusPrefix(name: string): string {
  const normalized = normalizeName(name);
  return normalized.startsWith('nexus-') ? normalized.slice('nexus-'.length) : normalized;
}

function classifyNamespace(name: string): InstalledSkillNamespace {
  const normalized = normalizeName(name);
  const unprefixed = stripNexusPrefix(normalized);
  if (CANONICAL_COMMAND_SET.has(unprefixed)) {
    return 'nexus_canonical';
  }
  if (NEXUS_SUPPORT_SKILLS.has(normalized) || NEXUS_SUPPORT_SKILLS.has(unprefixed)) {
    return 'nexus_support';
  }
  return 'external_installed';
}

function inferTags(name: string, description: string | null): string[] {
  const haystack = `${name} ${description ?? ''}`;
  const tags: string[] = [];
  for (const rule of TAG_KEYWORDS) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      tags.push(rule.tag);
    }
  }
  return unique(tags);
}

function parseSkillFrontmatter(content: string): { name: string | null; description: string | null } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { name: null, description: null };
  }

  const frontmatter = match[1] ?? '';
  let name: string | null = null;
  let description: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const key = field[1];
    const value = (field[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name') {
      name = value;
    } else if (key === 'description') {
      description = value;
    }
  }
  return { name, description };
}

function discoverSkillFiles(root: string, maxDepth = 4): string[] {
  const files: string[] = [];
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) {
    return files;
  }

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
          continue;
        }
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        files.push(join(dir, entry.name));
      }
    }
  }

  try {
    walk(resolvedRoot, 0);
  } catch {
    return files;
  }
  return files;
}

export function classifyInstalledSkill(input: {
  name: string;
  description: string | null;
  path: string;
  source_root: string;
}): InstalledSkillRecord {
  const name = normalizeName(input.name);
  const namespace = classifyNamespace(name);
  return {
    name,
    surface: commandSurface(name),
    description: input.description,
    path: input.path,
    source_root: input.source_root,
    namespace,
    tags: inferTags(name, input.description),
  };
}

export function defaultExternalSkillRoots(cwd: string, home = homedir()): string[] {
  return unique([
    join(cwd, '.claude', 'skills'),
    join(cwd, '.agents', 'skills'),
    join(cwd, '.gemini', 'skills'),
    join(cwd, '.factory', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.gemini', 'skills'),
    join(home, '.factory', 'skills'),
  ]);
}

type DiscoverExternalInstalledSkillsOptions =
  | {
    roots: string[];
    cwd?: string;
    home?: string;
  }
  | {
    roots?: undefined;
    cwd: string;
    home?: string;
  };

export function discoverExternalInstalledSkills(options: DiscoverExternalInstalledSkillsOptions): InstalledSkillRecord[] {
  if (process.env.NEXUS_EXTERNAL_SKILLS === '0') {
    return [];
  }

  const roots = options.roots ?? defaultExternalSkillRoots(options.cwd, options.home);
  const skills: InstalledSkillRecord[] = [];
  const seenPaths = new Set<string>();
  for (const root of roots) {
    for (const skillPath of discoverSkillFiles(root)) {
      if (seenPaths.has(skillPath)) {
        continue;
      }
      seenPaths.add(skillPath);
      let content = '';
      try {
        if (!statSync(skillPath).isFile()) continue;
        content = readFileSync(skillPath, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSkillFrontmatter(content);
      const fallbackName = basename(skillPath.replace(/\/SKILL\.md$/, ''));
      skills.push(classifyInstalledSkill({
        name: parsed.name ?? fallbackName,
        description: parsed.description,
        path: skillPath,
        source_root: root,
      }));
    }
  }
  return skills;
}

function contextTags(matrix: VerificationMatrixRecord | null | undefined): string[] {
  const tags: string[] = [];
  if (matrix?.design_impact && matrix.design_impact !== 'none') {
    tags.push('design', 'design-review');
  }
  if (matrix?.support_skill_signals?.browse?.suggested) {
    tags.push('browser', 'qa');
  }
  if (matrix?.support_skill_signals?.connect_chrome?.suggested) {
    tags.push('browser');
  }
  if (matrix?.support_skill_signals?.setup_browser_cookies?.suggested) {
    tags.push('auth', 'browser');
  }
  if (matrix?.support_skill_signals?.cso?.suggested) {
    tags.push('security', 'risk');
  }
  if (matrix?.support_skill_signals?.benchmark?.suggested) {
    tags.push('performance');
  }
  if (matrix?.support_skill_signals?.simplify?.suggested) {
    tags.push('maintainability', 'simplification');
  }
  return unique(tags);
}

function skillScore(skill: InstalledSkillRecord, stage: CanonicalCommandId, matrix: VerificationMatrixRecord | null | undefined): number {
  const stageTags = STAGE_INTENT_TAGS[stage] ?? [];
  const ctxTags = contextTags(matrix);
  let score = 0;
  for (const tag of skill.tags) {
    if (stageTags.includes(tag)) {
      score += 3;
    }
    if (ctxTags.includes(tag)) {
      score += 2;
    }
  }
  return score;
}

function externalAction(skill: InstalledSkillRecord, stage: CanonicalCommandId, matrix: VerificationMatrixRecord | null | undefined): CompletionAdvisorActionRecord {
  const matchedTags = skill.tags.filter((tag) =>
    (STAGE_INTENT_TAGS[stage] ?? []).includes(tag) || contextTags(matrix).includes(tag)
  );
  const reason = matchedTags.length > 0
    ? `Installed skill matches /${stage} because it is tagged ${matchedTags.join(', ')}.`
    : `Installed skill matches /${stage} by stage intent.`;
  const checklistCategories = matchedTags.filter((tag): tag is VerificationChecklistCategory =>
    CHECKLIST_TAGS.has(tag as VerificationChecklistCategory)
  );
  return {
    id: `run_external_${skill.name.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
    kind: 'external_installed_skill',
    surface: skill.surface,
    invocation: skill.surface,
    label: `Run installed skill \`${skill.surface}\``,
    description: skill.description ?? `Run the installed ${skill.surface} skill as supporting context.`,
    recommended: false,
    visibility_reason: reason,
    why_this_skill: matchedTags.length > 0
      ? `Use this because the installed skill matches ${matchedTags.join(', ')} context for /${stage}.`
      : `Use this because the installed skill matches /${stage} stage intent.`,
    evidence_signal: {
      kind: 'installed_skill',
      summary: matchedTags.length > 0
        ? `Installed skill tags matched: ${matchedTags.join(', ')}.`
        : `Installed skill was selected from /${stage} stage intent.`,
      source_paths: [skill.path],
      checklist_categories: checklistCategories,
    },
  };
}

export function rankExternalInstalledSkillsForAdvisor(input: {
  stage: CanonicalCommandId;
  verification_matrix?: VerificationMatrixRecord | null;
  skills: InstalledSkillRecord[];
  existing_surfaces: string[];
  limit?: number;
}): CompletionAdvisorActionRecord[] {
  const existing = new Set(input.existing_surfaces);
  const emitted = new Set<string>();
  return input.skills
    .filter((skill) => skill.namespace === 'external_installed')
    .filter((skill) => !existing.has(skill.surface))
    .map((skill) => ({
      skill,
      score: skillScore(skill, input.stage, input.verification_matrix),
    }))
    .filter((ranked) => ranked.score >= 2)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .filter((ranked) => {
      if (emitted.has(ranked.skill.surface)) {
        return false;
      }
      emitted.add(ranked.skill.surface);
      return true;
    })
    .slice(0, input.limit ?? 3)
    .map(({ skill }) => externalAction(skill, input.stage, input.verification_matrix));
}
