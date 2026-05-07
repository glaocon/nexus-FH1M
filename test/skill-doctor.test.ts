import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import {
  analyzeSkillDoctorTarget,
  buildSkillDoctorReport,
  readSkillDoctorTargets,
  renderSkillDoctorReport,
} from '../scripts/skill/doctor';

const ROOT = path.resolve(import.meta.dir, '..');

const baseSkill = `---
name: focused-support
description: Use when a focused support workflow needs bounded verification for browser QA.
---

# Focused Support

This support skill has clear scope and evidence requirements.

## Workflow

1. Inspect the target.
2. Produce a report.
3. Stop before unrelated edits.

## Output Contract

Write a report with findings and evidence.

## Verification

Run the relevant tests and attach browser evidence.

## Safety

Do not modify unrelated files.
`;

describe('skill doctor', () => {
  test('flags long skills, missing verification, broad triggers, and canonical command conflicts', () => {
    const longSkill = `${baseSkill}\n${Array.from({ length: 12 }, (_, index) => `Extra line ${index}`).join('\n')}`;
    const weakSkill = `---
name: weak-support
description: Use when doing work.
---

# Weak

This support skill has generic guidance.

## Workflow

1. Do the thing.

## Output Contract

Write a report.

## Safety

Do not touch unrelated files.
`;
    const conflictSkill = baseSkill.replace('name: focused-support', 'name: review');

    const report = buildSkillDoctorReport([
      { path: 'long/SKILL.md.tmpl', content: longSkill },
      { path: 'weak/SKILL.md.tmpl', content: weakSkill },
      { path: 'custom-review/SKILL.md.tmpl', content: conflictSkill },
    ], {
      longSkillLineThreshold: 10,
    });

    expect(report.issueCounts).toMatchObject({
      too_long: 3,
      missing_verification: 1,
      trigger_too_broad: 1,
      canonical_command_conflict: 1,
    });

    const issues = report.results.flatMap((result) => result.issues);
    expect(issues.map((issue) => issue.kind)).toContain('too_long');
    expect(issues.map((issue) => issue.kind)).toContain('missing_verification');
    expect(issues.map((issue) => issue.kind)).toContain('trigger_too_broad');
    expect(issues.map((issue) => issue.kind)).toContain('canonical_command_conflict');
  });

  test('does not flag expected canonical command wrappers as conflicts', () => {
    const result = analyzeSkillDoctorTarget({
      path: 'review/SKILL.md.tmpl',
      content: baseSkill.replace('name: focused-support', 'name: review'),
      longSkillLineThreshold: 100,
    });

    expect(result.category).toBe('canonical');
    expect(result.issues.map((issue) => issue.kind)).not.toContain('canonical_command_conflict');

    const generatedHostResult = analyzeSkillDoctorTarget({
      path: '.agents/skills/nexus-review/SKILL.md',
      content: baseSkill.replace('name: focused-support', 'name: nexus-review'),
      longSkillLineThreshold: 100,
    });

    expect(generatedHostResult.category).toBe('canonical');
    expect(generatedHostResult.issues.map((issue) => issue.kind)).not.toContain('canonical_command_conflict');
  });

  test('renders a compact maintainer report', () => {
    const report = buildSkillDoctorReport([
      {
        path: 'weak/SKILL.md.tmpl',
        content: `---
name: weak
description: Use when doing work.
---

# Weak
`,
      },
    ]);

    const rendered = renderSkillDoctorReport(report);
    expect(rendered).toContain('Skill Doctor');
    expect(rendered).toContain('trigger_too_broad');
    expect(rendered).toContain('missing_verification');
    expect(rendered).toContain('weak/SKILL.md.tmpl');
  });

  test('renders source templates and generated host skills as separate sections', () => {
    const report = buildSkillDoctorReport([
      {
        path: 'heavy/SKILL.md.tmpl',
        content: baseSkill,
        targetKind: 'source_template',
      },
      {
        path: '.agents/skills/nexus-heavy/SKILL.md',
        content: baseSkill,
        targetKind: 'generated_host',
      },
    ], {
      longSkillLineThreshold: 10,
    });

    const rendered = renderSkillDoctorReport(report);
    expect(rendered).toContain('Source templates');
    expect(rendered).toContain('Generated host skills');
    expect(rendered).toContain('heavy/SKILL.md.tmpl');
    expect(rendered).toContain('.agents/skills/nexus-heavy/SKILL.md');
  });

  test('generated host length budget ignores shared scaffold before the active skill body', () => {
    const generatedHostSkill = `---
name: nexus-compact
description: Use when compact support work needs verification.
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->

## Preamble (run first)

\`\`\`bash
echo setup
\`\`\`

${Array.from({ length: 20 }, (_, index) => `Shared scaffold line ${index}`).join('\n')}

# {Title}

Template issue body.

# /compact

## Workflow

1. Do focused work.

## Output Contract

Write a report.

## Verification

Run the relevant checks.

## Safety

Do not touch unrelated files.
`;

    const result = analyzeSkillDoctorTarget({
      path: '.agents/skills/nexus-compact/SKILL.md',
      content: generatedHostSkill,
      targetKind: 'generated_host',
      longSkillLineThreshold: 20,
    });

    expect(result.lineCount).toBeGreaterThan(20);
    expect(result.size.budgetBasis).toBe('active_body');
    expect(result.size.scaffoldLineCount).toBeGreaterThan(15);
    expect(result.issues.map((issue) => issue.kind)).not.toContain('too_long');
  });

  test('generated host length budget still flags long active skill bodies', () => {
    const generatedHostSkill = `---
name: nexus-heavy
description: Use when heavy support work needs verification.
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->

# {Title}

Template issue body.

# /heavy

## Workflow

${Array.from({ length: 20 }, (_, index) => `${index + 1}. Step ${index + 1}.`).join('\n')}

## Output Contract

Write a report.

## Verification

Run the relevant checks.

## Safety

Do not touch unrelated files.
`;

    const result = analyzeSkillDoctorTarget({
      path: '.agents/skills/nexus-heavy/SKILL.md',
      content: generatedHostSkill,
      targetKind: 'generated_host',
      longSkillLineThreshold: 15,
    });
    const tooLong = result.issues.find((issue) => issue.kind === 'too_long');

    expect(tooLong).toBeDefined();
    expect(tooLong?.evidence).toContain('active-body lines');
    expect(tooLong?.evidence).toContain('shared scaffold');
  });

  test('cli emits json output and strict mode fails on warnings', () => {
    const jsonResult = spawnSync(process.execPath, ['run', 'scripts/skill/doctor.ts', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_SKILL_DOCTOR_MAX_LINES: '1',
        NEXUS_SKILL_DOCTOR_STRICT: '0',
      },
    });

    expect(jsonResult.status).toBe(0);
    const parsed = JSON.parse(jsonResult.stdout);
    expect(parsed).toMatchObject({
      kind: 'skill_doctor_report',
      strict: false,
    });
    expect(parsed.report.warnCount).toBeGreaterThan(0);

    const strictResult = spawnSync(process.execPath, ['run', 'scripts/skill/doctor.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_SKILL_DOCTOR_MAX_LINES: '1',
        NEXUS_SKILL_DOCTOR_STRICT: '1',
      },
    });

    expect(strictResult.status).toBe(1);
    expect(strictResult.stdout).toContain('Skill Doctor');
    expect(strictResult.stdout).toContain('strict mode');
  });

  test('source templates stay below the doctor length threshold', () => {
    const report = buildSkillDoctorReport(
      readSkillDoctorTargets(ROOT).filter((target) => target.targetKind === 'source_template'),
    );

    const sourceTooLong = report.results
      .flatMap((result) => result.issues)
      .filter((issue) => issue.kind === 'too_long');

    expect(sourceTooLong).toEqual([]);
  });

  test('generated host skills stay below the doctor length threshold', () => {
    const report = buildSkillDoctorReport(
      readSkillDoctorTargets(ROOT).filter((target) => target.targetKind === 'generated_host'),
    );

    const generatedTooLong = report.results
      .flatMap((result) => result.issues)
      .filter((issue) => issue.kind === 'too_long');

    expect(generatedTooLong).toEqual([]);
  });
});
