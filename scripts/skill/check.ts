#!/usr/bin/env bun
/**
 * skill:check — Health summary for all SKILL.md files.
 *
 * Reports:
 *   - Command validation (valid/invalid/snapshot errors)
 *   - Template coverage (which SKILL.md files have .tmpl sources)
 *   - Freshness check (generated files match committed files)
 */

import { validateSkill } from '../../test/helpers/skill-parser';
import { discoverTemplates, discoverSkillFiles } from './discover-skills';
import { analyzeSkillFile, type SkillAnatomyResult } from './anatomy';
import { buildSkillDoctorReport, readSkillDoctorTargets, renderSkillDoctorReport } from './doctor';
import {
  describeSkillSourcePath,
  type SkillStructureCategory,
} from '../../lib/nexus/skill-structure';
import { projectHostSkillInstallRoot } from '../../lib/nexus/host-roots';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..', '..');

// Find all SKILL.md files (dynamic discovery — no hardcoded list)
const SKILL_FILES = discoverSkillFiles(ROOT);
const TEMPLATES = discoverTemplates(ROOT);

let hasErrors = false;
const rubricStrict = process.env.NEXUS_SKILL_RUBRIC_STRICT === '1';
const doctorStrict = process.env.NEXUS_SKILL_DOCTOR_STRICT === '1';

// ─── Skills ─────────────────────────────────────────────────

console.log('  Skills:');
for (const file of SKILL_FILES) {
  const fullPath = path.join(ROOT, file);
  const result = validateSkill(fullPath);

  if (result.warnings.length > 0) {
    console.log(`  \u26a0\ufe0f  ${file.padEnd(30)} — ${result.warnings.join(', ')}`);
    continue;
  }

  const totalValid = result.valid.length;
  const totalInvalid = result.invalid.length;
  const totalSnapErrors = result.snapshotFlagErrors.length;

  if (totalInvalid > 0 || totalSnapErrors > 0) {
    hasErrors = true;
    console.log(`  \u274c ${file.padEnd(30)} — ${totalValid} valid, ${totalInvalid} invalid, ${totalSnapErrors} snapshot errors`);
    for (const inv of result.invalid) {
      console.log(`      line ${inv.line}: unknown command '${inv.command}'`);
    }
    for (const se of result.snapshotFlagErrors) {
      console.log(`      line ${se.command.line}: ${se.error}`);
    }
  } else {
    console.log(`  \u2705 ${file.padEnd(30)} — ${totalValid} commands, all valid`);
  }
}

// ─── Skill Anatomy Rubric ──────────────────────────────────

function formatRubricGaps(result: SkillAnatomyResult): string {
  return result.missing.map((criterion) => criterion.id).join(', ');
}

console.log('\n  Support Skill Rubric (source templates):');
const anatomyTargets = TEMPLATES
  .map(({ tmpl }) => tmpl)
  .map((tmpl) => ({ tmpl, result: analyzeSkillFile(tmpl, ROOT) }))
  .filter(({ result }) => result.category === 'support');

let rubricPass = 0;
let rubricWarn = 0;
let rubricFail = 0;

for (const { tmpl, result } of anatomyTargets) {
  const label = `${result.score}/${result.maxScore}`;
  if (result.status === 'pass') {
    rubricPass++;
    console.log(`  \u2705 ${tmpl.padEnd(30)} — ${result.category}, ${label}`);
    continue;
  }

  if (result.status === 'warn') {
    rubricWarn++;
    console.log(`  \u26a0\ufe0f  ${tmpl.padEnd(30)} — ${result.category}, ${label}; gaps: ${formatRubricGaps(result)}`);
    continue;
  }

  rubricFail++;
  if (rubricStrict) {
    hasErrors = true;
    console.log(`  \u274c ${tmpl.padEnd(30)} — ${result.category}, ${label}; gaps: ${formatRubricGaps(result)}`);
  } else {
    console.log(`  \u26a0\ufe0f  ${tmpl.padEnd(30)} — ${result.category}, ${label}; gaps: ${formatRubricGaps(result)} (strict: NEXUS_SKILL_RUBRIC_STRICT=1)`);
  }
}

console.log(`  Total: ${rubricPass} pass, ${rubricWarn} warn, ${rubricFail} fail${rubricStrict ? ' (strict)' : ' (non-blocking)'}`);

// ─── Skill Doctor ──────────────────────────────────────────

const doctorThreshold = Number(process.env.NEXUS_SKILL_DOCTOR_MAX_LINES ?? 600);
const doctorReport = buildSkillDoctorReport(
  readSkillDoctorTargets(ROOT),
  { longSkillLineThreshold: Number.isFinite(doctorThreshold) ? doctorThreshold : 600 },
);

console.log(`\n${renderSkillDoctorReport(doctorReport)}`);
if (doctorReport.failCount > 0 || (doctorStrict && doctorReport.warnCount > 0)) {
  hasErrors = true;
}
if (doctorStrict && doctorReport.warnCount > 0) {
  console.log('  Doctor strict mode is active: warnings are blocking (NEXUS_SKILL_DOCTOR_STRICT=1)');
}

// ─── Skill Structure ────────────────────────────────────────

console.log('\n  Skill Structure (source taxonomy):');

const structureCounts: Record<SkillStructureCategory, number> = {
  root: 0,
  canonical: 0,
  support: 0,
  safety: 0,
  alias: 0,
};
let plannedMoves = 0;

for (const { tmpl } of TEMPLATES) {
  try {
    const entry = describeSkillSourcePath(tmpl);
    structureCounts[entry.category]++;
    if (entry.movePolicy === 'planned_move') {
      plannedMoves++;
      console.log(`  ↪️  ${tmpl.padEnd(30)} — ${entry.category}; target ${entry.targetSourcePath}`);
      continue;
    }

    console.log(`  ✅ ${tmpl.padEnd(30)} — ${entry.category}; in place`);
  } catch (err: any) {
    hasErrors = true;
    console.log(`  ❌ ${tmpl.padEnd(30)} — unknown source taxonomy (${err?.message ?? err})`);
  }
}

console.log(
  `  Total: ${TEMPLATES.length} templates — `
  + `${structureCounts.root} root, `
  + `${structureCounts.canonical} canonical, `
  + `${structureCounts.support} support, `
  + `${structureCounts.safety} safety, `
  + `${structureCounts.alias} alias; `
  + `${plannedMoves} planned moves (non-blocking)`,
);

// ─── Templates ──────────────────────────────────────────────

console.log('\n  Templates:');

for (const { tmpl, output } of TEMPLATES) {
  const tmplPath = path.join(ROOT, tmpl);
  const outPath = path.join(ROOT, output);
  if (!fs.existsSync(tmplPath)) {
    console.log(`  \u26a0\ufe0f  ${output.padEnd(30)} — no template`);
    continue;
  }
  if (!fs.existsSync(outPath)) {
    hasErrors = true;
    console.log(`  \u274c ${output.padEnd(30)} — generated file missing! Run: bun run gen:skill-docs`);
    continue;
  }
  console.log(`  \u2705 ${tmpl.padEnd(30)} \u2192 ${output}`);
}

// Skills without templates
for (const file of SKILL_FILES) {
  const tmplPath = path.join(ROOT, file + '.tmpl');
  if (!fs.existsSync(tmplPath) && !TEMPLATES.some(t => t.output === file)) {
    console.log(`  \u26a0\ufe0f  ${file.padEnd(30)} — no template (OK if no $B commands)`);
  }
}

// ─── Codex Skills ───────────────────────────────────────────

function discoverGeneratedHostSkillDirs(root: string): string[] {
  const dirs: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        walk(absolutePath);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        dirs.push(path.relative(root, dir).replace(/\\/g, '/'));
      }
    }
  }
  walk(root);
  return dirs.sort((a, b) => a.localeCompare(b));
}

const AGENTS_DIR = path.join(ROOT, projectHostSkillInstallRoot('codex').path);
if (fs.existsSync(AGENTS_DIR)) {
  console.log('\n  Codex Skills (.agents/skills/):');
  const codexDirs = discoverGeneratedHostSkillDirs(AGENTS_DIR);
  let codexCount = 0;
  let codexMissing = 0;
  for (const dir of codexDirs) {
    const skillMd = path.join(AGENTS_DIR, dir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      codexCount++;
      const content = fs.readFileSync(skillMd, 'utf-8');
      // Quick validation: must have frontmatter with name + description only
      const hasClaude = content.includes('.claude/skills');
      if (hasClaude) {
        hasErrors = true;
        console.log(`  \u274c ${dir.padEnd(30)} — contains .claude/skills reference`);
      } else {
        console.log(`  \u2705 ${dir.padEnd(30)} — OK`);
      }
    } else {
      codexMissing++;
      hasErrors = true;
      console.log(`  \u274c ${dir.padEnd(30)} — SKILL.md missing`);
    }
  }
  console.log(`  Total: ${codexCount} skills, ${codexMissing} missing`);
} else {
  console.log('\n  Codex Skills: .agents/skills/ not found (run: bun run gen:skill-docs --host codex)');
}

// ─── Factory Skills ─────────────────────────────────────────

const FACTORY_DIR = path.join(ROOT, projectHostSkillInstallRoot('factory').path);
if (fs.existsSync(FACTORY_DIR)) {
  console.log('\n  Factory Skills (.factory/skills/):');
  const factoryDirs = discoverGeneratedHostSkillDirs(FACTORY_DIR);
  let factoryCount = 0;
  let factoryMissing = 0;
  for (const dir of factoryDirs) {
    const skillMd = path.join(FACTORY_DIR, dir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      factoryCount++;
      const content = fs.readFileSync(skillMd, 'utf-8');
      const hasClaude = content.includes('.claude/skills');
      if (hasClaude) {
        hasErrors = true;
        console.log(`  \u274c ${dir.padEnd(30)} — contains .claude/skills reference`);
      } else {
        console.log(`  \u2705 ${dir.padEnd(30)} — OK`);
      }
    } else {
      factoryMissing++;
      hasErrors = true;
      console.log(`  \u274c ${dir.padEnd(30)} — SKILL.md missing`);
    }
  }
  console.log(`  Total: ${factoryCount} skills, ${factoryMissing} missing`);
} else {
  console.log('\n  Factory Skills: .factory/skills/ not found (run: bun run gen:skill-docs --host factory)');
}

// ─── Gemini CLI Skills ──────────────────────────────────────

const GEMINI_DIR = path.join(ROOT, projectHostSkillInstallRoot('gemini-cli').path);
if (fs.existsSync(GEMINI_DIR)) {
  console.log('\n  Gemini CLI Skills (.gemini/skills/):');
  const geminiDirs = discoverGeneratedHostSkillDirs(GEMINI_DIR);
  let geminiCount = 0;
  let geminiMissing = 0;
  for (const dir of geminiDirs) {
    const skillMd = path.join(GEMINI_DIR, dir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      geminiCount++;
      const content = fs.readFileSync(skillMd, 'utf-8');
      const hasClaude = content.includes('.claude/skills');
      if (hasClaude) {
        hasErrors = true;
        console.log(`  ❌ ${dir.padEnd(30)} — contains .claude/skills reference`);
      } else {
        console.log(`  ✅ ${dir.padEnd(30)} — OK`);
      }
    } else {
      geminiMissing++;
      hasErrors = true;
      console.log(`  ❌ ${dir.padEnd(30)} — SKILL.md missing`);
    }
  }
  console.log(`  Total: ${geminiCount} skills, ${geminiMissing} missing`);
} else {
  console.log('\n  Gemini CLI Skills: .gemini/skills/ not found (run: bun run gen:skill-docs --host gemini-cli)');
}

// ─── Freshness ──────────────────────────────────────────────

console.log('\n  Freshness (Claude):');
try {
  execSync('bun run scripts/skill/gen-skill-docs.ts --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 All Claude generated files are fresh');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c Claude generated files are stale:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      Run: bun run gen:skill-docs');
}

console.log('\n  Freshness (Codex):');
try {
  execSync('bun run scripts/skill/gen-skill-docs.ts --host codex --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 All Codex generated files are fresh');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c Codex generated files are stale:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      Run: bun run gen:skill-docs --host codex');
}

console.log('\n  Freshness (Factory):');
try {
  execSync('bun run scripts/skill/gen-skill-docs.ts --host factory --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 All Factory generated files are fresh');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c Factory generated files are stale:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      Run: bun run gen:skill-docs --host factory');
}

console.log('\n  Freshness (Gemini CLI):');
try {
  execSync('bun run scripts/skill/gen-skill-docs.ts --host gemini-cli --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 All Gemini CLI generated files are fresh');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c Gemini CLI generated files are stale:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      Run: bun run gen:skill-docs --host gemini-cli');
}

console.log('');
process.exit(hasErrors ? 1 : 0);
