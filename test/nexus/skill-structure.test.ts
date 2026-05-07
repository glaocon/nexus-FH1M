import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';
import { CANONICAL_MANIFEST, LEGACY_ALIASES } from '../../lib/nexus/command-manifest';
import {
  SAFETY_SKILL_NAMES,
  SUPPORT_SKILL_NAMES,
  allPlannedSkillStructureEntries,
  currentSkillSourcePathForName,
  describeSkillSourcePath,
  candidateSkillArtifactPathsForName,
  skillNameFromSourcePath,
  skillSourceCategoryForName,
  targetSkillSourcePathForName,
} from '../../lib/nexus/skill-structure';
import { discoverTemplates } from '../../scripts/skill/discover-skills';

const ROOT = path.resolve(import.meta.dir, '..', '..');

describe('nexus skill source structure', () => {
  test('classifies every current source template into the planned taxonomy', () => {
    const templates = discoverTemplates(ROOT);
    const unknown: string[] = [];

    for (const { tmpl } of templates) {
      try {
        describeSkillSourcePath(tmpl);
      } catch {
        unknown.push(tmpl);
      }
    }

    expect(unknown).toEqual([]);
  });

  test('maps canonical lifecycle commands to the canonical namespace', () => {
    for (const command of Object.keys(CANONICAL_MANIFEST)) {
      expect(skillSourceCategoryForName(command)).toBe('canonical');
      expect(targetSkillSourcePathForName(command)).toBe(`skills/canonical/${command}/SKILL.md.tmpl`);
    }
  });

  test('maps aliases, safety, support, and root entrypoint to distinct namespaces', () => {
    for (const alias of Object.keys(LEGACY_ALIASES)) {
      expect(skillSourceCategoryForName(alias)).toBe('alias');
      expect(targetSkillSourcePathForName(alias)).toBe(`skills/aliases/${alias}/SKILL.md.tmpl`);
    }

    for (const safety of SAFETY_SKILL_NAMES) {
      expect(skillSourceCategoryForName(safety)).toBe('safety');
      expect(targetSkillSourcePathForName(safety)).toBe(`skills/safety/${safety}/SKILL.md.tmpl`);
    }

    for (const support of SUPPORT_SKILL_NAMES) {
      expect(skillSourceCategoryForName(support)).toBe('support');
      expect(targetSkillSourcePathForName(support)).toBe(`skills/support/${support}/SKILL.md.tmpl`);
    }

    expect(describeSkillSourcePath('SKILL.md.tmpl')).toMatchObject({
      name: 'nexus',
      category: 'root',
      targetSourcePath: 'skills/root/nexus/SKILL.md.tmpl',
      movePolicy: 'planned_move',
    });

    expect(currentSkillSourcePathForName('nexus')).toBe('skills/root/nexus/SKILL.md.tmpl');
    expect(targetSkillSourcePathForName('nexus')).toBe('skills/root/nexus/SKILL.md.tmpl');
    expect(skillNameFromSourcePath('skills/root/nexus/SKILL.md.tmpl')).toBe('nexus');
    expect(describeSkillSourcePath('skills/root/nexus/SKILL.md.tmpl')).toMatchObject({
      name: 'nexus',
      category: 'root',
      targetSourcePath: 'skills/root/nexus/SKILL.md.tmpl',
      movePolicy: 'in_place',
    });
  });

  test('source skill files live in the taxonomy directories after physical migration', () => {
    const migratedEntries = allPlannedSkillStructureEntries()
      .filter((entry) => entry.category !== 'root')
      .filter((entry) => {
        const legacySourcePath = `${entry.name}/SKILL.md.tmpl`;
        return existsSync(path.join(ROOT, entry.targetSourcePath))
          || existsSync(path.join(ROOT, legacySourcePath));
      });

    for (const entry of migratedEntries) {
      const legacySourcePath = `${entry.name}/SKILL.md.tmpl`;
      expect(existsSync(path.join(ROOT, entry.targetSourcePath))).toBe(true);
      expect(existsSync(path.join(ROOT, legacySourcePath))).toBe(false);
      expect(describeSkillSourcePath(entry.targetSourcePath)).toMatchObject({
        name: entry.name,
        category: entry.category,
        movePolicy: 'in_place',
      });
    }
  });

  test('recognizes structured source namespace paths', () => {
    expect(describeSkillSourcePath('skills/canonical/review/SKILL.md.tmpl')).toMatchObject({
      name: 'review',
      category: 'canonical',
      movePolicy: 'in_place',
    });

    expect(describeSkillSourcePath('skills/support/simplify/SKILL.md.tmpl')).toMatchObject({
      name: 'simplify',
      category: 'support',
      movePolicy: 'in_place',
    });

    expect(describeSkillSourcePath('skills/safety/guard/SKILL.md.tmpl')).toMatchObject({
      name: 'guard',
      category: 'safety',
      movePolicy: 'in_place',
    });
  });

  test('exposes active artifact candidates for generated skill files', () => {
    expect(candidateSkillArtifactPathsForName('review', 'SKILL.md')).toEqual([
      'skills/canonical/review/SKILL.md',
    ]);
    expect(candidateSkillArtifactPathsForName('simplify', 'SKILL.md.tmpl')).toEqual([
      'skills/support/simplify/SKILL.md.tmpl',
    ]);
    expect(candidateSkillArtifactPathsForName('nexus', 'SKILL.md')).toEqual([
      'skills/root/nexus/SKILL.md',
    ]);
  });

  test('primary non-e2e tests read generated skills through structure-aware helpers', () => {
    const files = [
      'test/audit-compliance.test.ts',
      'test/gen-skill-docs.test.ts',
      'test/skill-llm-eval.test.ts',
      'test/skill-routing-e2e.test.ts',
      'test/skill-validation.test.ts',
      'test/nexus/claude-boundary.test.ts',
      'test/nexus/product-surface.test.ts',
    ];
    const forbiddenRootSkillPath = /\b(?:path\.)?join\(ROOT,\s*['"][^'"]+['"],\s*['"]SKILL\.md(?:\.tmpl)?['"]\)|\b(?:path\.)?join\(ROOT,\s*['"][^'"]+\/SKILL\.md(?:\.tmpl)?['"]\)/g;
    const violations = files.flatMap((file) => {
      const content = readFileSync(path.join(ROOT, file), 'utf-8');
      return [...content.matchAll(forbiddenRootSkillPath)].map((match) => `${file}: ${match[0]}`);
    });

    expect(violations).toEqual([]);
  });

  test('has one taxonomy entry per known skill name', () => {
    const entries = allPlannedSkillStructureEntries();
    const names = entries.map((entry) => entry.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('nexus');
    expect(names).toContain('discover');
    expect(names).toContain('plan-ceo-review');
    expect(names).toContain('simplify');
    expect(names).toContain('guard');
  });
});
