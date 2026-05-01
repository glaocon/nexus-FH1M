import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { resolveRuntimeCwd } from '../../lib/nexus/runtime-cwd';

const ROOT = join(import.meta.dir, '..', '..');
const EXPLICIT_CWD_LIBRARY_HELPERS = [
  'lib/nexus/governance.ts',
  'lib/nexus/ledger.ts',
  'lib/nexus/status.ts',
  'lib/nexus/install-metadata.ts',
  'lib/nexus/release-contract.ts',
  'lib/nexus/release-publish.ts',
  'lib/nexus/external-skills.ts',
] as const;

describe('resolveRuntimeCwd', () => {
  test('returns the process cwd when no override is set', () => {
    expect(resolveRuntimeCwd({}, '/tmp/project')).toBe('/tmp/project');
  });

  test('prefers NEXUS_PROJECT_CWD when provided', () => {
    expect(resolveRuntimeCwd({ NEXUS_PROJECT_CWD: '/tmp/active-project' }, '/tmp/nexus-install')).toBe(
      '/tmp/active-project',
    );
  });

  test('ignores blank overrides', () => {
    expect(resolveRuntimeCwd({ NEXUS_PROJECT_CWD: '   ' }, '/tmp/project')).toBe('/tmp/project');
  });

  test('keeps library helpers on explicit cwd parameters', () => {
    const ambientDefaults = EXPLICIT_CWD_LIBRARY_HELPERS.flatMap((file) => {
      const content = readFileSync(join(ROOT, file), 'utf8');
      return [...content.matchAll(/process\.cwd\(\)/g)].map((match) => `${file}:${match.index}`);
    });

    expect(ambientDefaults).toEqual([]);
  });
});
