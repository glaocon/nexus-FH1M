import { describe, expect, test } from 'bun:test';

type ReleaseChangeScenario = {
  importedSnapshotChangesOnly?: boolean;
  provenanceOnlyChanges?: boolean;
  nexusOwnedStageContentChanged?: boolean;
  nexusOwnedStagePackChanged?: boolean;
  providerCompatibilitySeamChanged?: boolean;
};

function requiresNexusRelease(change: ReleaseChangeScenario): boolean {
  return (
    change.nexusOwnedStageContentChanged === true ||
    change.nexusOwnedStagePackChanged === true ||
    change.providerCompatibilitySeamChanged === true
  );
}

const CCB_COMPATIBILITY_INVENTORY_FIXTURE = [
  '# CCB Inventory',
  '',
  'Claude Code Bridge remains compatibility infrastructure for provider routing.',
  'It is not a full-retirement target while Nexus-owned seams still depend on it.',
].join('\n');

const ABSORPTION_STATUS_FIXTURE = [
  '# Absorption Status',
  '',
  'Claude Code Bridge remains compatibility infrastructure and not a full-retirement target.',
  'Refresh decisions are maintainer-only and not governed lifecycle truth.',
  '',
  '- `ignore`',
  '- `defer`',
  '- `absorb_partial`',
  '- `absorb_full`',
  '- `reject`',
].join('\n');

const UPSTREAM_REFRESH_RUNBOOK_FIXTURE = [
  '# Upstream Refresh',
  '',
  'Treat CCB as compatibility infrastructure and not a full-retirement target.',
  'Refresh decisions are maintainer-only and not governed lifecycle truth.',
  '',
  '- `ignore`',
  '- `defer`',
  '- `absorb_partial`',
  '- `absorb_full`',
  '- `reject`',
].join('\n');

describe('nexus upstream release gate', () => {
  test('requires release when Nexus-owned stage content changes', () => {
    expect(
      requiresNexusRelease({
        nexusOwnedStageContentChanged: true,
      }),
    ).toBe(true);
  });

  test('requires release when Nexus-owned stage pack changes', () => {
    expect(
      requiresNexusRelease({
        nexusOwnedStagePackChanged: true,
      }),
    ).toBe(true);
  });

  test('requires release when Nexus-owned changes are mixed with imported snapshot or provenance-only updates', () => {
    expect(
      requiresNexusRelease({
        importedSnapshotChangesOnly: true,
        nexusOwnedStageContentChanged: true,
      }),
    ).toBe(true);

    expect(
      requiresNexusRelease({
        provenanceOnlyChanges: true,
        nexusOwnedStagePackChanged: true,
      }),
    ).toBe(true);
  });

  test('treats imported snapshot changes alone as insufficient for release', () => {
    expect(requiresNexusRelease({ importedSnapshotChangesOnly: true })).toBe(false);
  });

  test('treats provenance-only source-map updates as non-releasing metadata changes', () => {
    expect(requiresNexusRelease({ provenanceOnlyChanges: true })).toBe(false);
  });

  test('allows provider compatibility changes to require release when they ship through Nexus-owned seams', () => {
    expect(
      requiresNexusRelease({
        providerCompatibilitySeamChanged: true,
      }),
    ).toBe(true);
  });

  test('CCB compatibility policy fixtures keep infrastructure separate from full retirement', () => {
    for (const document of [
      CCB_COMPATIBILITY_INVENTORY_FIXTURE,
      ABSORPTION_STATUS_FIXTURE,
      UPSTREAM_REFRESH_RUNBOOK_FIXTURE,
    ]) {
      expect(document).toContain('compatibility infrastructure');
      expect(document).toContain('not a full-retirement target');
    }
  });

  test('refresh policy fixtures keep maintainer-only decisions separate from governed truth', () => {
    for (const decision of ['ignore', 'defer', 'absorb_partial', 'absorb_full', 'reject'] as const) {
      expect(UPSTREAM_REFRESH_RUNBOOK_FIXTURE).toContain(`\`${decision}\``);
      expect(ABSORPTION_STATUS_FIXTURE).toContain(`\`${decision}\``);
    }

    for (const document of [UPSTREAM_REFRESH_RUNBOOK_FIXTURE, ABSORPTION_STATUS_FIXTURE]) {
      expect(document).toContain('maintainer-only');
      expect(document).toContain('not governed lifecycle truth');
    }
  });
});
