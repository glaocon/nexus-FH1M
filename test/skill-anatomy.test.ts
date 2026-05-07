import { describe, expect, test } from 'bun:test';
import {
  analyzeSkillAnatomy,
  classifySkillPath,
  SUPPORT_SKILL_RUBRIC,
} from '../scripts/skill/anatomy';

const completeSupportSkill = `---
name: demo-support
description: Use when a Nexus support workflow needs a focused quality check.
---

# /demo-support

This support skill runs a focused workflow with clear boundaries.

## Setup

Read the relevant project files and detect the target scope.

## Instructions

1. Inspect the target.
2. Produce a report.
3. Stop before unrelated edits.

## Output Contract

Write a report with findings, evidence, and follow-up recommendations.

## Verification

- Confirm tests pass.
- Attach screenshot evidence when visual behavior is involved.

## Safety

Do not modify unrelated files. Use AskUserQuestion before destructive actions.
`;

describe('skill anatomy rubric', () => {
  test('classifies root, canonical, alias, and support skill paths', () => {
    expect(classifySkillPath('SKILL.md.tmpl')).toBe('root');
    expect(classifySkillPath('build/SKILL.md.tmpl')).toBe('canonical');
    expect(classifySkillPath('autoplan/SKILL.md.tmpl')).toBe('alias');
    expect(classifySkillPath('browse/SKILL.md.tmpl')).toBe('support');
  });

  test('passes a complete support skill against the rubric', () => {
    const result = analyzeSkillAnatomy({
      path: 'demo-support/SKILL.md.tmpl',
      content: completeSupportSkill,
      category: 'support',
    });

    expect(result.status).toBe('pass');
    expect(result.score).toBe(SUPPORT_SKILL_RUBRIC.maxScore);
    expect(result.missing.map((item) => item.id)).toEqual([]);
  });

  test('reports actionable gaps for underspecified support skills', () => {
    const result = analyzeSkillAnatomy({
      path: 'weak/SKILL.md.tmpl',
      category: 'support',
      content: `---
name: weak
description: Does a useful thing.
---

# Weak

Useful notes.
`,
    });

    expect(result.status).toBe('fail');
    expect(result.missing.map((item) => item.id)).toContain('trigger_conditions');
    expect(result.missing.map((item) => item.id)).toContain('workflow_steps');
    expect(result.missing.map((item) => item.id)).toContain('output_contract');
    expect(result.missing.map((item) => item.id)).toContain('verification_evidence');
    expect(result.missing.map((item) => item.id)).toContain('safety_boundaries');
  });
});
