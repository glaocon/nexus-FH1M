#!/usr/bin/env bun
import * as fs from 'fs';
import * as path from 'path';
import { CANONICAL_MANIFEST } from '../../lib/nexus/command-manifest';
import {
  skillNameFromSourcePath,
  skillSourceCategoryForName,
  type SkillStructureCategory,
} from '../../lib/nexus/skill-structure';
import {
  analyzeSkillAnatomy,
  type SkillAnatomyCategory,
  type SkillAnatomyResult,
} from './anatomy';
import { discoverSkillFiles, discoverTemplates } from './discover-skills';

export type SkillDoctorIssueKind =
  | 'too_long'
  | 'missing_verification'
  | 'trigger_too_broad'
  | 'canonical_command_conflict';

export type SkillDoctorSeverity = 'warn' | 'fail';
export type SkillDoctorTargetKind = 'source_template' | 'generated_host';

export type SkillDoctorIssue = {
  kind: SkillDoctorIssueKind;
  severity: SkillDoctorSeverity;
  path: string;
  skillName: string;
  evidence: string;
  recommendation: string;
};

export type SkillDoctorSizeProfile = {
  totalLineCount: number;
  activeLineCount: number;
  scaffoldLineCount: number;
  budgetLineCount: number;
  budgetBasis: 'total' | 'active_body';
  activeBodyStartLine: number | null;
};

export type SkillDoctorTarget = {
  path: string;
  content: string;
  category?: SkillAnatomyCategory;
  targetKind?: SkillDoctorTargetKind;
};

export type SkillDoctorResult = {
  path: string;
  skillName: string;
  category: SkillAnatomyCategory;
  targetKind: SkillDoctorTargetKind;
  lineCount: number;
  size: SkillDoctorSizeProfile;
  anatomy: SkillAnatomyResult;
  issues: SkillDoctorIssue[];
};

export type SkillDoctorReport = {
  results: SkillDoctorResult[];
  issueCounts: Record<SkillDoctorIssueKind, number>;
  warnCount: number;
  failCount: number;
  longSkillLineThreshold: number;
};

export type SkillDoctorOptions = {
  longSkillLineThreshold?: number;
};

const DEFAULT_LONG_SKILL_LINE_THRESHOLD = 600;
const CANONICAL_COMMANDS = new Set(Object.keys(CANONICAL_MANIFEST));
const TARGET_KIND_LABELS: Record<SkillDoctorTargetKind, string> = {
  source_template: 'Source templates',
  generated_host: 'Generated host skills',
};

const BROAD_TRIGGER_PATTERNS = [
  /\buse when\b.{0,80}\b(anything|everything|any task|all tasks|general work|doing work|working on (a )?(task|project)|need help)\b/i,
  /\buse for\b.{0,80}\b(anything|everything|any task|all tasks|general work|doing work)\b/i,
  /\bwhen asked\b\.?$/i,
];

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeName(name: string): string {
  return name.trim().replace(/^\/+/, '').toLowerCase();
}

function stripNexusPrefix(name: string): string {
  const normalized = normalizeName(name);
  return normalized.startsWith('nexus-') ? normalized.slice('nexus-'.length) : normalized;
}

function anatomyCategoryFromStructure(category: SkillStructureCategory | null): SkillAnatomyCategory {
  if (category === 'safety') {
    return 'support';
  }
  return category ?? 'support';
}

function classifyDoctorPath(filePath: string): SkillAnatomyCategory {
  const skillName = skillNameFromSourcePath(filePath);
  return anatomyCategoryFromStructure(skillSourceCategoryForName(skillName));
}

function inferTargetKind(filePath: string): SkillDoctorTargetKind {
  return normalizePath(filePath).endsWith('.tmpl') ? 'source_template' : 'generated_host';
}

function frontmatterBlock(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? '';
}

function parseFrontmatter(content: string): { name: string | null; description: string } {
  const frontmatter = frontmatterBlock(content);
  if (!frontmatter) {
    return { name: null, description: '' };
  }

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null;
  const descriptionMatch = frontmatter.match(/^description:\s*(.*)$/m);
  if (!descriptionMatch) {
    return { name, description: '' };
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
    return { name, description: body.join(' ') };
  }

  return { name, description: firstLine.replace(/^['"]|['"]$/g, '') };
}

function hasBroadTrigger(description: string): boolean {
  const normalized = description.replace(/\s+/g, ' ').trim();
  return BROAD_TRIGGER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function lineCount(content: string): number {
  return content.split(/\r?\n/).length;
}

function activeBodyStartLine(content: string): number | null {
  const lines = content.split(/\r?\n/);
  const titleMarkerIndex = lines.findIndex((line) => line.trim() === '# {Title}');
  const h1AfterMarker = titleMarkerIndex >= 0
    ? lines.findIndex((line, index) => index > titleMarkerIndex && /^#\s+\S/.test(line.trim()) && line.trim() !== '# {Title}')
    : -1;
  if (h1AfterMarker >= 0) {
    return h1AfterMarker + 1;
  }

  const commandH1Index = lines.findIndex((line) => /^#\s+\/\S+/.test(line.trim()));
  if (commandH1Index >= 0) {
    return commandH1Index + 1;
  }

  return null;
}

function sizeProfile(content: string, targetKind: SkillDoctorTargetKind): SkillDoctorSizeProfile {
  const totalLineCount = lineCount(content);
  if (targetKind === 'source_template') {
    return {
      totalLineCount,
      activeLineCount: totalLineCount,
      scaffoldLineCount: 0,
      budgetLineCount: totalLineCount,
      budgetBasis: 'total',
      activeBodyStartLine: 1,
    };
  }

  const startLine = activeBodyStartLine(content);
  if (!startLine) {
    return {
      totalLineCount,
      activeLineCount: totalLineCount,
      scaffoldLineCount: 0,
      budgetLineCount: totalLineCount,
      budgetBasis: 'total',
      activeBodyStartLine: null,
    };
  }

  const scaffoldLineCount = Math.max(0, startLine - 1);
  const activeLineCount = Math.max(0, totalLineCount - scaffoldLineCount);
  return {
    totalLineCount,
    activeLineCount,
    scaffoldLineCount,
    budgetLineCount: activeLineCount,
    budgetBasis: 'active_body',
    activeBodyStartLine: startLine,
  };
}

function issue(input: {
  kind: SkillDoctorIssueKind;
  severity: SkillDoctorSeverity;
  path: string;
  skillName: string;
  evidence: string;
  recommendation: string;
}): SkillDoctorIssue {
  return input;
}

export function analyzeSkillDoctorTarget(input: SkillDoctorTarget & SkillDoctorOptions): SkillDoctorResult {
  const category = input.category ?? classifyDoctorPath(input.path);
  const targetKind = input.targetKind ?? inferTargetKind(input.path);
  const anatomy = analyzeSkillAnatomy({
    path: input.path,
    content: input.content,
    category,
  });
  const frontmatter = parseFrontmatter(input.content);
  const skillName = normalizeName(frontmatter.name ?? skillNameFromSourcePath(input.path));
  const lines = lineCount(input.content);
  const size = sizeProfile(input.content, targetKind);
  const longSkillLineThreshold = input.longSkillLineThreshold ?? DEFAULT_LONG_SKILL_LINE_THRESHOLD;
  const issues: SkillDoctorIssue[] = [];

  if (size.budgetLineCount > longSkillLineThreshold) {
    issues.push(issue({
      kind: 'too_long',
      severity: 'warn',
      path: input.path,
      skillName,
      evidence: targetKind === 'generated_host' && size.budgetBasis === 'active_body'
        ? `${size.activeLineCount} active-body lines exceeds ${longSkillLineThreshold}-line doctor threshold (${lines} total, ${size.scaffoldLineCount} shared scaffold lines ignored)`
        : `${lines} lines exceeds ${longSkillLineThreshold}-line doctor threshold`,
      recommendation: 'Split reference material, examples, or command tables into lazy-loaded reference sidecars so the active skill stays focused.',
    }));
  }

  const missingIds = new Set(anatomy.missing.map((criterion) => criterion.id));
  if (category === 'support' && missingIds.has('verification_evidence')) {
    issues.push(issue({
      kind: 'missing_verification',
      severity: 'warn',
      path: input.path,
      skillName,
      evidence: 'support skill anatomy rubric is missing verification_evidence',
      recommendation: 'Add a Verification or Evidence section with concrete tests, screenshots, reports, or status artifacts.',
    }));
  }

  if (category === 'support' && (missingIds.has('trigger_conditions') || hasBroadTrigger(frontmatter.description))) {
    issues.push(issue({
      kind: 'trigger_too_broad',
      severity: 'warn',
      path: input.path,
      skillName,
      evidence: frontmatter.description
        ? `frontmatter description is too broad: "${frontmatter.description}"`
        : 'frontmatter description does not declare a concrete trigger',
      recommendation: 'Rewrite the description around specific "Use when..." conditions and domain signals.',
    }));
  }

  const declaredSurface = stripNexusPrefix(skillName);
  const pathSurface = stripNexusPrefix(skillNameFromSourcePath(input.path));
  const conflicts = [declaredSurface, pathSurface].filter((surface) => CANONICAL_COMMANDS.has(surface));
  if (category !== 'canonical' && conflicts.length > 0) {
    issues.push(issue({
      kind: 'canonical_command_conflict',
      severity: 'fail',
      path: input.path,
      skillName,
      evidence: `non-canonical skill declares canonical command surface: /${conflicts[0]}`,
      recommendation: 'Rename the support skill or convert it into the canonical lifecycle wrapper owned by the manifest.',
    }));
  }

  return {
    path: input.path,
    skillName,
    category,
    targetKind,
    lineCount: lines,
    size,
    anatomy,
    issues,
  };
}

export function buildSkillDoctorReport(
  targets: SkillDoctorTarget[],
  options: SkillDoctorOptions = {},
): SkillDoctorReport {
  const results = targets.map((target) => analyzeSkillDoctorTarget({
    ...target,
    longSkillLineThreshold: options.longSkillLineThreshold,
  }));
  const allIssues = results.flatMap((result) => result.issues);
  const issueCounts: Record<SkillDoctorIssueKind, number> = {
    too_long: 0,
    missing_verification: 0,
    trigger_too_broad: 0,
    canonical_command_conflict: 0,
  };
  for (const item of allIssues) {
    issueCounts[item.kind]++;
  }

  return {
    results,
    issueCounts,
    warnCount: allIssues.filter((item) => item.severity === 'warn').length,
    failCount: allIssues.filter((item) => item.severity === 'fail').length,
    longSkillLineThreshold: options.longSkillLineThreshold ?? DEFAULT_LONG_SKILL_LINE_THRESHOLD,
  };
}

function summarizeIssueKind(kind: SkillDoctorIssueKind): string {
  switch (kind) {
    case 'too_long':
      return 'skills that may overload context';
    case 'missing_verification':
      return 'skills without concrete completion evidence';
    case 'trigger_too_broad':
      return 'skills whose activation conditions are weak or generic';
    case 'canonical_command_conflict':
      return 'skills that collide with canonical lifecycle commands';
  }
}

function issuesForKind(result: SkillDoctorResult, kind: SkillDoctorIssueKind): SkillDoctorIssue[] {
  return result.issues.filter((item) => item.kind === kind);
}

export function renderSkillDoctorReport(report: SkillDoctorReport): string {
  const lines: string[] = [];
  lines.push('  Skill Doctor:');

  const issueKinds: SkillDoctorIssueKind[] = [
    'too_long',
    'missing_verification',
    'trigger_too_broad',
    'canonical_command_conflict',
  ];

  if (report.warnCount === 0 && report.failCount === 0) {
    lines.push('  ✅ no high-risk skill doctor findings');
    return lines.join('\n');
  }

  for (const targetKind of ['source_template', 'generated_host'] satisfies SkillDoctorTargetKind[]) {
    const groupResults = report.results.filter((result) => result.targetKind === targetKind);
    if (groupResults.length === 0) {
      continue;
    }

    const groupIssues = groupResults.flatMap((result) => result.issues);
    lines.push(`  ${TARGET_KIND_LABELS[targetKind]}:`);
    if (groupIssues.length === 0) {
      lines.push('    ✅ no high-risk findings');
      continue;
    }

    for (const kind of issueKinds) {
      const issueRows = groupResults.flatMap((result) => issuesForKind(result, kind));
      if (issueRows.length === 0) {
        continue;
      }

      lines.push(`    ${kind === 'canonical_command_conflict' ? '❌' : '⚠️ '} ${kind}: ${issueRows.length} — ${summarizeIssueKind(kind)}`);
      for (const item of issueRows.slice(0, 8)) {
        lines.push(`        ${item.path} — ${item.evidence}; ${item.recommendation}`);
      }
      if (issueRows.length > 8) {
        lines.push(`        ... ${issueRows.length - 8} more`);
      }
    }

    const groupWarnCount = groupIssues.filter((item) => item.severity === 'warn').length;
    const groupFailCount = groupIssues.filter((item) => item.severity === 'fail').length;
    lines.push(`    Subtotal: ${groupWarnCount} warn, ${groupFailCount} fail`);
  }

  lines.push(`  Total: ${report.warnCount} warn, ${report.failCount} fail (line threshold: ${report.longSkillLineThreshold})`);
  return lines.join('\n');
}

function readTemplateTargets(root: string): SkillDoctorTarget[] {
  return discoverTemplates(root).map(({ tmpl }) => ({
    path: tmpl,
    content: fs.readFileSync(path.join(root, tmpl), 'utf-8'),
    targetKind: 'source_template',
  }));
}

function readGeneratedSkillTargets(root: string): SkillDoctorTarget[] {
  const targets: SkillDoctorTarget[] = discoverSkillFiles(root).map((file) => ({
    path: file,
    content: fs.readFileSync(path.join(root, file), 'utf-8'),
    targetKind: 'generated_host',
  }));

  for (const hostRoot of ['.agents/skills', '.factory/skills']) {
    const absoluteHostRoot = path.join(root, hostRoot);
    if (!fs.existsSync(absoluteHostRoot)) {
      continue;
    }

    for (const dir of fs.readdirSync(absoluteHostRoot).sort()) {
      const skillPath = path.join(hostRoot, dir, 'SKILL.md');
      const absoluteSkillPath = path.join(root, skillPath);
      if (fs.existsSync(absoluteSkillPath)) {
        targets.push({
          path: skillPath,
          content: fs.readFileSync(absoluteSkillPath, 'utf-8'),
          targetKind: 'generated_host',
        });
      }
    }
  }

  return targets;
}

export function readSkillDoctorTargets(root: string): SkillDoctorTarget[] {
  return [
    ...readTemplateTargets(root),
    ...readGeneratedSkillTargets(root),
  ];
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..', '..');
  const json = process.argv.includes('--json');
  const strict = process.env.NEXUS_SKILL_DOCTOR_STRICT === '1';
  const threshold = Number(process.env.NEXUS_SKILL_DOCTOR_MAX_LINES ?? DEFAULT_LONG_SKILL_LINE_THRESHOLD);
  const report = buildSkillDoctorReport(readSkillDoctorTargets(root), {
    longSkillLineThreshold: Number.isFinite(threshold) ? threshold : DEFAULT_LONG_SKILL_LINE_THRESHOLD,
  });
  const exitCode = report.failCount > 0 || (strict && report.warnCount > 0) ? 1 : 0;
  if (json) {
    console.log(JSON.stringify({
      kind: 'skill_doctor_report',
      strict,
      blocking: exitCode !== 0,
      report,
    }, null, 2));
  } else {
    console.log(renderSkillDoctorReport(report));
    if (strict && report.warnCount > 0) {
      console.log('  Doctor strict mode is active: warnings are blocking (NEXUS_SKILL_DOCTOR_STRICT=1)');
    }
  }
  process.exit(exitCode);
}
