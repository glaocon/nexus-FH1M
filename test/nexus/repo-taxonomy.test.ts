import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  REFERENCE_COMPAT_MAPPINGS,
  REPO_TAXONOMY_CATEGORIES,
  REPO_TAXONOMY_ENTRIES,
  REPO_TAXONOMY_FACADES,
  classifyRepoPath,
  findRepoTaxonomyFacade,
  findRepoTaxonomyEntry,
  plannedFacadePaths,
  plannedTopLevelRoots,
  referenceCompatSourceCandidates,
  resolveReferenceCompatSource,
} from '../../lib/nexus/repo-taxonomy';

const ROOT = join(import.meta.dir, '..', '..');

describe('nexus repo taxonomy v2', () => {
  test('defines the intended top-level maintenance categories', () => {
    expect(plannedTopLevelRoots()).toEqual([
      'skills',
      'runtimes',
      'references',
      'lib',
      'hosts',
      'vendor',
      'bin',
      'scripts',
      'docs',
      'test',
    ]);

    expect(REPO_TAXONOMY_CATEGORIES.hosts.children).toEqual([
      'claude',
      'codex',
      'gemini-cli',
      'factory',
      'kiro',
    ]);
  });

  test('keeps current paths as the active source of truth while recording future target paths', () => {
    expect(findRepoTaxonomyEntry('review')).toMatchObject({
      current_path: 'references/review/specialists',
      target_path: 'references/review/specialists',
      move_policy: 'keep_in_place',
      risk_level: 'medium',
    });

    expect(findRepoTaxonomyEntry('review-reference-sidecars')).toMatchObject({
      current_path: 'references/review',
      target_path: 'references/review',
      move_policy: 'keep_in_place',
      risk_level: 'medium',
    });

    expect(findRepoTaxonomyEntry('design-references')).toMatchObject({
      current_path: 'references/design',
      target_path: 'references/design',
      move_policy: 'keep_in_place',
      risk_level: 'medium',
    });

    expect(findRepoTaxonomyEntry('design')).toMatchObject({
      current_path: 'runtimes/design',
      target_path: 'runtimes/design',
      move_policy: 'keep_in_place',
      risk_level: 'high',
    });

    expect(findRepoTaxonomyEntry('browse')).toMatchObject({
      current_path: 'runtimes/browse',
      target_path: 'runtimes/browse',
      move_policy: 'keep_in_place',
      risk_level: 'high',
    });

    expect(findRepoTaxonomyEntry('qa')).toMatchObject({
      current_path: 'references/qa',
      target_path: 'references/qa',
      move_policy: 'keep_in_place',
      risk_level: 'medium',
    });

    expect(findRepoTaxonomyEntry('cso')).toMatchObject({
      current_path: 'references/cso',
      target_path: 'references/cso',
      move_policy: 'keep_in_place',
      risk_level: 'low',
    });

    expect(findRepoTaxonomyEntry('gemini-cli-host')).toMatchObject({
      current_path: '.gemini',
      target_path: 'hosts/gemini-cli',
      move_policy: 'future_move',
    });

    expect(findRepoTaxonomyEntry('browse-extension')).toMatchObject({
      current_path: 'runtimes/browse/extension',
      target_path: 'runtimes/browse/extension',
      move_policy: 'keep_in_place',
      risk_level: 'medium',
    });

    expect(findRepoTaxonomyEntry('codex-openai-metadata')).toMatchObject({
      current_path: 'hosts/codex/openai.yaml',
      target_path: 'hosts/codex/openai.yaml',
      move_policy: 'keep_in_place',
    });

    expect(findRepoTaxonomyEntry('codex-openai-metadata-compat-root')).toMatchObject({
      current_path: 'agents',
      target_path: 'agents',
      move_policy: 'compat_required',
    });

    expect(findRepoTaxonomyEntry('codex-openai-metadata-compat')).toMatchObject({
      current_path: 'agents/openai.yaml',
      target_path: 'hosts/codex/openai.yaml',
      move_policy: 'compat_required',
    });

    expect(findRepoTaxonomyEntry('claude-host')).toMatchObject({
      current_path: 'hosts/claude/rules',
      target_path: 'hosts/claude/rules',
      move_policy: 'keep_in_place',
    });

    expect(findRepoTaxonomyEntry('claude-host-compat-rules')).toMatchObject({
      current_path: '.claude/rules',
      target_path: 'hosts/claude/rules',
      move_policy: 'compat_required',
    });
  });

  test('records compatibility paths for runtime and reference assets installed under NEXUS_ROOT', () => {
    const browse = findRepoTaxonomyEntry('browse');
    const review = findRepoTaxonomyEntry('review');
    const reviewSidecars = findRepoTaxonomyEntry('review-reference-sidecars');
    const qa = findRepoTaxonomyEntry('qa');
    const design = findRepoTaxonomyEntry('design');
    const designHtml = findRepoTaxonomyEntry('design-html');
    const careful = findRepoTaxonomyEntry('careful');
    const freeze = findRepoTaxonomyEntry('freeze');
    const claudeHost = findRepoTaxonomyEntry('claude-host');
    const codexMetadata = findRepoTaxonomyEntry('codex-openai-metadata');

    expect(browse?.runtime_compat_paths).toContain('$NEXUS_ROOT/browse/dist');
    expect(browse?.runtime_compat_paths).toContain('$NEXUS_ROOT/browse/bin');
    expect(findRepoTaxonomyEntry('browse-extension')?.runtime_compat_paths).toContain(
      '$NEXUS_ROOT/extension/manifest.json'
    );
    expect(review?.runtime_compat_paths).toContain('$NEXUS_ROOT/review/specialists/testing.md');
    expect(reviewSidecars?.runtime_compat_paths).toContain('$NEXUS_ROOT/review/checklist.md');
    expect(qa?.runtime_compat_paths).toContain('$NEXUS_ROOT/qa/templates/qa-report-template.md');
    expect(design?.runtime_compat_paths).toContain('$NEXUS_ROOT/design/references');
    expect(designHtml?.runtime_compat_paths).toContain('$NEXUS_ROOT/design-html/vendor');
    expect(careful?.runtime_compat_paths).toContain('$NEXUS_ROOT/careful/bin/check-careful.sh');
    expect(freeze?.runtime_compat_paths).toContain('$NEXUS_ROOT/freeze/bin/check-freeze.sh');
    expect(claudeHost?.runtime_compat_paths).toContain('.claude/rules/maintainer-surface.md');
    expect(codexMetadata?.runtime_compat_paths).toContain('agents/openai.yaml');
  });

  test('defines future references source candidates while preserving installed compatibility paths', () => {
    expect(REFERENCE_COMPAT_MAPPINGS).toContainEqual({
      compat_path: 'review/specialists',
      future_source_path: 'references/review/specialists',
      current_source_path: 'review/specialists',
      kind: 'directory',
    });
    expect(REFERENCE_COMPAT_MAPPINGS).toContainEqual({
      compat_path: 'qa/templates',
      future_source_path: 'references/qa/templates',
      current_source_path: 'qa/templates',
      kind: 'directory',
    });
    expect(REFERENCE_COMPAT_MAPPINGS).toContainEqual({
      compat_path: 'design/references',
      future_source_path: 'references/design',
      current_source_path: 'design/references',
      kind: 'directory',
    });
    expect(REFERENCE_COMPAT_MAPPINGS).toContainEqual({
      compat_path: 'cso/ACKNOWLEDGEMENTS.md',
      future_source_path: 'references/cso/ACKNOWLEDGEMENTS.md',
      current_source_path: 'cso/ACKNOWLEDGEMENTS.md',
      kind: 'file',
    });

    expect(referenceCompatSourceCandidates('review/specialists')).toEqual([
      'references/review/specialists',
      'review/specialists',
    ]);
  });

  test('resolves reference compatibility sources by preferring future paths and falling back to current paths', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-reference-compat-'));

    try {
      mkdirSync(join(fixtureRoot, 'review'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'review', 'checklist.md'), 'current');
      expect(resolveReferenceCompatSource('review/checklist.md', fixtureRoot)).toBe('review/checklist.md');

      mkdirSync(join(fixtureRoot, 'references', 'review'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'references', 'review', 'checklist.md'), 'future');
      expect(resolveReferenceCompatSource('review/checklist.md', fixtureRoot)).toBe(
        'references/review/checklist.md'
      );

      mkdirSync(join(fixtureRoot, 'qa', 'templates'), { recursive: true });
      expect(resolveReferenceCompatSource('qa/templates', fixtureRoot)).toBe('qa/templates');

      mkdirSync(join(fixtureRoot, 'references', 'qa', 'templates'), { recursive: true });
      expect(resolveReferenceCompatSource('qa/templates', fixtureRoot)).toBe('references/qa/templates');

      expect(resolveReferenceCompatSource('cso/ACKNOWLEDGEMENTS.md', fixtureRoot)).toBeNull();
      expect(() => resolveReferenceCompatSource('unknown/reference.md', fixtureRoot)).toThrow(
        'Unknown reference compatibility path'
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('creates only safe navigation facades for physical taxonomy roots', () => {
    expect(plannedFacadePaths()).toEqual([
      'runtimes/README.md',
      'runtimes/browse.md',
      'runtimes/design.md',
      'runtimes/design-html.md',
      'runtimes/hooks.md',
      'references/README.md',
      'references/review/README.md',
      'references/qa/README.md',
      'references/design/README.md',
      'references/cso/README.md',
      'hosts/README.md',
      'hosts/claude/README.md',
      'hosts/codex/README.md',
      'hosts/gemini-cli/README.md',
      'hosts/factory/README.md',
    ]);

    for (const facade of REPO_TAXONOMY_FACADES) {
      expect(facade.kind).toBe('navigation_only');
      expect(existsSync(join(ROOT, facade.facade_path))).toBe(true);
      expect(facade.active_source_paths.length).toBeGreaterThan(0);
      for (const activeSourcePath of facade.active_source_paths) {
        expect(existsSync(join(ROOT, activeSourcePath))).toBe(true);
      }
    }

    expect(findRepoTaxonomyFacade('references/review/README.md')).toMatchObject({
      active_source_paths: ['references/review'],
    });
    expect(findRepoTaxonomyFacade('references/review/README.md')).not.toHaveProperty('guarded_future_paths');

    expect(findRepoTaxonomyFacade('references/qa/README.md')).toMatchObject({
      active_source_paths: ['references/qa'],
    });
    expect(findRepoTaxonomyFacade('references/qa/README.md')).not.toHaveProperty('guarded_future_paths');

    expect(findRepoTaxonomyFacade('references/design/README.md')).toMatchObject({
      active_source_paths: ['references/design'],
    });
    expect(findRepoTaxonomyFacade('references/design/README.md')).not.toHaveProperty('guarded_future_paths');

    expect(findRepoTaxonomyFacade('references/cso/README.md')).toMatchObject({
      active_source_paths: ['references/cso'],
    });
    expect(findRepoTaxonomyFacade('references/cso/README.md')).not.toHaveProperty('guarded_future_paths');

    expect(findRepoTaxonomyFacade('runtimes/browse.md')).toMatchObject({
      active_source_paths: ['runtimes/browse'],
    });
    expect(findRepoTaxonomyFacade('runtimes/browse.md')).not.toHaveProperty('guarded_future_paths');

    expect(findRepoTaxonomyFacade('runtimes/design.md')).toMatchObject({
      active_source_paths: ['runtimes/design'],
    });
    expect(findRepoTaxonomyFacade('runtimes/design.md')).not.toHaveProperty('guarded_future_paths');

    const facadePaths = new Set(plannedFacadePaths());
    for (const mapping of REFERENCE_COMPAT_MAPPINGS) {
      expect(facadePaths.has(mapping.future_source_path)).toBe(false);
    }
  });

  test('moves reference batches under references while preserving runtime compatibility paths', () => {
    const movedReferencePaths = [
      ['review/checklist.md', 'references/review/checklist.md'],
      ['review/design-checklist.md', 'references/review/design-checklist.md'],
      ['review/greptile-triage.md', 'references/review/greptile-triage.md'],
      ['review/TODOS-format.md', 'references/review/TODOS-format.md'],
      ['review/specialists/api-contract.md', 'references/review/specialists/api-contract.md'],
      ['review/specialists/data-migration.md', 'references/review/specialists/data-migration.md'],
      ['review/specialists/maintainability.md', 'references/review/specialists/maintainability.md'],
      ['review/specialists/performance.md', 'references/review/specialists/performance.md'],
      ['review/specialists/red-team.md', 'references/review/specialists/red-team.md'],
      ['review/specialists/security.md', 'references/review/specialists/security.md'],
      ['review/specialists/testing.md', 'references/review/specialists/testing.md'],
      ['qa/templates/qa-report-template.md', 'references/qa/templates/qa-report-template.md'],
      ['qa/references/issue-taxonomy.md', 'references/qa/references/issue-taxonomy.md'],
      ['cso/ACKNOWLEDGEMENTS.md', 'references/cso/ACKNOWLEDGEMENTS.md'],
      ['design/references/animations.md', 'references/design/animations.md'],
      ['design/references/design-consultation-cheatsheet.md', 'references/design/design-consultation-cheatsheet.md'],
      ['design/references/design-context.md', 'references/design/design-context.md'],
      ['design/references/design-review-methodology.md', 'references/design/design-review-methodology.md'],
      ['design/references/editable-pptx.md', 'references/design/editable-pptx.md'],
      ['design/references/governance.md', 'references/design/governance.md'],
      ['design/references/hard-rules.md', 'references/design/hard-rules.md'],
      ['design/references/outside-voices.md', 'references/design/outside-voices.md'],
      ['design/references/plan-design-principles.md', 'references/design/plan-design-principles.md'],
      ['design/references/pretext-html-engine.md', 'references/design/pretext-html-engine.md'],
      ['design/references/shotgun-loop.md', 'references/design/shotgun-loop.md'],
      ['design/references/slide-decks.md', 'references/design/slide-decks.md'],
      ['design/references/tweaks-system.md', 'references/design/tweaks-system.md'],
      ['design/references/verification.md', 'references/design/verification.md'],
      ['design/references/video-export.md', 'references/design/video-export.md'],
    ];

    for (const [legacySourcePath, movedSourcePath] of movedReferencePaths) {
      expect(existsSync(join(ROOT, movedSourcePath))).toBe(true);
      expect(existsSync(join(ROOT, legacySourcePath))).toBe(false);
    }

    expect(resolveReferenceCompatSource('review/checklist.md', ROOT)).toBe(
      'references/review/checklist.md'
    );
    expect(resolveReferenceCompatSource('review/specialists', ROOT)).toBe(
      'references/review/specialists'
    );
    expect(resolveReferenceCompatSource('qa/templates', ROOT)).toBe('references/qa/templates');
    expect(resolveReferenceCompatSource('cso/ACKNOWLEDGEMENTS.md', ROOT)).toBe(
      'references/cso/ACKNOWLEDGEMENTS.md'
    );
    expect(resolveReferenceCompatSource('design/references', ROOT)).toBe('references/design');
  });

  test('does not create remaining guarded future reference sources that setup would treat as real assets', () => {
    const guardedFuturePaths = REPO_TAXONOMY_FACADES.flatMap(
      (facade) => facade.guarded_future_paths ?? []
    );

    expect(guardedFuturePaths).not.toContain('references/review/specialists');
    expect(guardedFuturePaths).not.toContain('references/design');
    expect(guardedFuturePaths).not.toContain('references/review/checklist.md');
    expect(guardedFuturePaths).not.toContain('references/qa/templates');
    expect(guardedFuturePaths).not.toContain('references/cso/ACKNOWLEDGEMENTS.md');
    expect(guardedFuturePaths).not.toContain('runtimes/design-html');
    expect(guardedFuturePaths).not.toContain('runtimes/hooks/careful');
    expect(guardedFuturePaths).not.toContain('runtimes/hooks/freeze');
    expect(guardedFuturePaths).not.toContain('hosts/claude/rules');
    expect(guardedFuturePaths).not.toContain('hosts/codex/openai.yaml');

    for (const guardedPath of guardedFuturePaths) {
      expect(existsSync(join(ROOT, guardedPath))).toBe(false);
    }
  });

  test('documents all high-risk source roots that should not be moved ad hoc', () => {
    const documented = new Set(REPO_TAXONOMY_ENTRIES.map((entry) => entry.current_path));
    const optionalGeneratedCompatRoots = ['.agents', '.factory'];

    expect(optionalGeneratedCompatRoots.filter((root) => !documented.has(root))).toEqual([]);

    for (const root of optionalGeneratedCompatRoots) {
      if (existsSync(join(ROOT, root))) {
        expect(findRepoTaxonomyEntry(root)?.move_policy).toBeDefined();
      }
    }
  });

  test('classifies representative repo files into exact future taxonomy paths', () => {
    expect(classifyRepoPath('runtimes/browse/extension/sidepanel.js')).toMatchObject({
      category: 'runtimes',
      target_path: 'runtimes/browse/extension/sidepanel.js',
      move_policy: 'keep_in_place',
    });

    expect(classifyRepoPath('runtimes/browse/src/cli.ts')).toMatchObject({
      category: 'runtimes',
      target_path: 'runtimes/browse/src/cli.ts',
      move_policy: 'keep_in_place',
      rule: 'browse',
    });

    expect(classifyRepoPath('agents/openai.yaml')).toMatchObject({
      category: 'hosts',
      target_path: 'hosts/codex/openai.yaml',
      move_policy: 'compat_required',
      rule: 'codex-openai-metadata-compat',
    });

    expect(classifyRepoPath('agents/README.md')).toMatchObject({
      category: 'hosts',
      target_path: 'agents/README.md',
      move_policy: 'compat_required',
      rule: 'codex-openai-metadata-compat-root',
    });

    expect(classifyRepoPath('hosts/codex/openai.yaml')).toMatchObject({
      category: 'hosts',
      target_path: 'hosts/codex/openai.yaml',
      move_policy: 'keep_in_place',
      rule: 'codex-openai-metadata',
    });

    expect(classifyRepoPath('hosts/claude/rules/skill-authoring.md')).toMatchObject({
      category: 'hosts',
      target_path: 'hosts/claude/rules/skill-authoring.md',
      move_policy: 'keep_in_place',
      rule: 'claude-host',
    });

    expect(classifyRepoPath('.claude/rules/skill-authoring.md')).toMatchObject({
      category: 'hosts',
      target_path: 'hosts/claude/rules/skill-authoring.md',
      move_policy: 'compat_required',
      rule: 'claude-host-compat-rules',
    });

    expect(classifyRepoPath('references/design/hard-rules.md')).toMatchObject({
      category: 'references',
      target_path: 'references/design/hard-rules.md',
      move_policy: 'keep_in_place',
      rule: 'design-references',
    });

    expect(classifyRepoPath('runtimes/design/src/cli.ts')).toMatchObject({
      category: 'runtimes',
      target_path: 'runtimes/design/src/cli.ts',
      move_policy: 'keep_in_place',
      rule: 'design',
    });

    expect(classifyRepoPath('runtimes/design-html/vendor/pretext.js')).toMatchObject({
      category: 'runtimes',
      target_path: 'runtimes/design-html/vendor/pretext.js',
      move_policy: 'keep_in_place',
      rule: 'design-html',
    });

    expect(classifyRepoPath('runtimes/hooks/careful/bin/check-careful.sh')).toMatchObject({
      category: 'runtimes',
      target_path: 'runtimes/hooks/careful/bin/check-careful.sh',
      move_policy: 'keep_in_place',
      rule: 'careful',
    });

    expect(classifyRepoPath('runtimes/hooks/freeze/bin/check-freeze.sh')).toMatchObject({
      category: 'runtimes',
      target_path: 'runtimes/hooks/freeze/bin/check-freeze.sh',
      move_policy: 'keep_in_place',
      rule: 'freeze',
    });

    expect(classifyRepoPath('references/review/checklist.md')).toMatchObject({
      category: 'references',
      target_path: 'references/review/checklist.md',
      move_policy: 'keep_in_place',
      rule: 'review-reference-sidecars',
    });

    expect(classifyRepoPath('references/review/specialists/testing.md')).toMatchObject({
      category: 'references',
      target_path: 'references/review/specialists/testing.md',
      move_policy: 'keep_in_place',
      rule: 'review',
    });

    expect(classifyRepoPath('skills/support/land/SKILL.md.tmpl')).toMatchObject({
      category: 'skills',
      target_path: 'skills/support/land/SKILL.md.tmpl',
      move_policy: 'keep_in_place',
    });

    expect(classifyRepoPath('README.md')).toMatchObject({
      category: 'root',
      target_path: 'README.md',
      move_policy: 'keep_in_place',
    });
  });

  test('repo path inventory documents every tracked file plus the inventory generator itself', () => {
    const inventoryPath = join(ROOT, 'docs/architecture/repo-path-inventory.md');
    const inventory = readFileSync(inventoryPath, 'utf8');
    const git = Bun.spawnSync(['git', 'ls-files'], { cwd: ROOT });
    const trackedFiles = new TextDecoder().decode(git.stdout).trim().split('\n').filter(Boolean);
    const expectedFiles = new Set([
      ...trackedFiles,
      'scripts/repo/path-inventory.ts',
      'docs/architecture/repo-path-inventory.md',
    ]);

    expect(inventory).toContain('# Nexus Repo Path Inventory');
    expect(inventory).toContain('Generated by `scripts/repo/path-inventory.ts`.');
    for (const file of expectedFiles) {
      expect(inventory).toContain(`| \`${file}\` |`);
    }
  });

  test('does not track retired upstream snapshot or compatibility roots', () => {
    const retiredPaths = [
      ['vendor', 'upstream'].join('/'),
      ['vendor', 'upstream-notes'].join('/'),
      'upstream',
      'upstream-notes',
    ];
    const git = Bun.spawnSync(['git', 'ls-files', ...retiredPaths], { cwd: ROOT });
    const trackedRetiredPaths = new TextDecoder().decode(git.stdout).trim();

    expect(trackedRetiredPaths).toBe('');

    for (const retiredPath of retiredPaths) {
      expect(existsSync(join(ROOT, retiredPath))).toBe(false);
    }
  });

  test('architecture note explains the conservative move policy and target tree', () => {
    const doc = readFileSync(join(ROOT, 'docs/architecture/repo-taxonomy-v2.md'), 'utf8');

    expect(doc).toContain('The root `/nexus` source template has moved into the skill taxonomy.');
    expect(doc).toContain('root `SKILL.md` remains a generated');
    expect(doc).toContain('documentation-only facades');
    expect(doc).toContain('hosts/gemini-cli');
    expect(doc).toContain('runtimes/browse');
    expect(doc).toContain('runtimes/browse/extension');
    expect(doc).toContain('references/review');
    expect(doc).toContain('references/design/README.md');
    expect(doc).toContain('hosts/claude/rules');
    expect(doc).toContain('hosts/codex/openai.yaml');
    expect(doc).toContain('agents/openai.yaml');
    expect(doc).toContain('$NEXUS_ROOT/review/checklist.md');
    expect(doc).toContain('docs/architecture/repo-path-inventory.md');
  });
});
