/**
 * Shared discovery for SKILL.md and .tmpl files.
 * Scans the root entrypoint, the active
 * skills/{canonical,support,safety,aliases}/<name>/ source layout, and legacy
 * one-level skill dirs during transitional overlap.
 */

import * as fs from 'fs';
import * as path from 'path';
import { skillNameFromSourcePath } from '../../lib/nexus/skill-structure';

const SKIP = new Set(['node_modules', '.git', 'dist']);
const STRUCTURED_SKILL_CATEGORIES = ['root', 'canonical', 'support', 'safety', 'aliases'];

function subdirs(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(d => d.name);
}

function pushIfExists(results: string[], root: string, rel: string): void {
  if (fs.existsSync(path.join(root, rel))) {
    results.push(rel);
  }
}

function structuredSkillPaths(root: string, fileName: 'SKILL.md' | 'SKILL.md.tmpl'): string[] {
  const skillsRoot = path.join(root, 'skills');
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }

  const results: string[] = [];
  for (const category of STRUCTURED_SKILL_CATEGORIES) {
    const categoryRoot = path.join(skillsRoot, category);
    if (!fs.existsSync(categoryRoot)) {
      continue;
    }

    for (const entry of fs.readdirSync(categoryRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      pushIfExists(results, root, `skills/${category}/${entry.name}/${fileName}`);
    }
  }
  return results;
}

function dedupeBySkillName(paths: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const rel of paths) {
    const name = skillNameFromSourcePath(rel);
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    deduped.push(rel);
  }
  return deduped;
}

export function discoverTemplates(root: string): Array<{ tmpl: string; output: string }> {
  const results: string[] = [];
  results.push(...structuredSkillPaths(root, 'SKILL.md.tmpl'));
  pushIfExists(results, root, 'SKILL.md.tmpl');

  for (const dir of subdirs(root)) {
    if (dir === 'skills') {
      continue;
    }
    const rel = dir ? `${dir}/SKILL.md.tmpl` : 'SKILL.md.tmpl';
    pushIfExists(results, root, rel);
  }

  return dedupeBySkillName(results)
    .map((tmpl) => ({ tmpl, output: tmpl.replace(/\.tmpl$/, '') }));
}

export function discoverSkillFiles(root: string): string[] {
  const results: string[] = [];
  results.push(...structuredSkillPaths(root, 'SKILL.md'));
  pushIfExists(results, root, 'SKILL.md');

  for (const dir of subdirs(root)) {
    if (dir === 'skills') {
      continue;
    }
    const rel = dir ? `${dir}/SKILL.md` : 'SKILL.md';
    pushIfExists(results, root, rel);
  }
  return dedupeBySkillName(results);
}
