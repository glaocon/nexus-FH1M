import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { getDefaultAdapterRegistry } from '../../lib/nexus/adapters/registry';
import {
  COMPATIBILITY_SURFACES,
  COMPATIBILITY_SURFACE_STATUSES,
  HISTORICAL_LEGACY_REFERENCES,
  REMOVED_COMPATIBILITY_BOUNDARY_SHIMS,
  REMOVED_LEGACY_RUNTIME_IDENTITIES,
} from '../../lib/nexus/compatibility-surface';
import { NEXUS_STAGE_PACKS } from '../../lib/nexus/types';

const INVENTORIES = [
  'vendor/upstream-notes/pm-skills-inventory.md',
  'vendor/upstream-notes/gsd-inventory.md',
  'vendor/upstream-notes/superpowers-inventory.md',
  'vendor/upstream-notes/ccb-inventory.md',
  'vendor/upstream-notes/legacy-host-migration-history.md',
] as const;

const IMPORTED_SOURCE_INVENTORIES = [
  'vendor/upstream-notes/pm-skills-inventory.md',
  'vendor/upstream-notes/gsd-inventory.md',
  'vendor/upstream-notes/superpowers-inventory.md',
  'vendor/upstream-notes/ccb-inventory.md',
] as const;

const SURFACE_DOCS = ['README.md', 'docs/skills.md'] as const;

const MANDATORY_FIELDS = [
  'classification',
  'milestone_state',
  'canonical_nexus_commands',
  'nexus_adapter_seams',
  'governed_artifact_boundaries',
  'normalization_required',
  'conflict_policy',
  'conflict_artifact_paths',
] as const;

const PROVENANCE_FIELDS = [
  'upstream_repo_url',
  'pinned_commit',
  'imported_path',
  'absorption_intent',
  'forbidden_authorities',
] as const;

const UPSTREAM_LOCK_FIXTURE = {
  upstreams: [
    {
      name: 'pm-skills',
      repo_url: 'https://github.com/pingcap/pm-skills.git',
      pinned_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      bootstrap_state: 'checked',
      last_checked_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      last_checked_at: '2026-04-30T00:00:00.000Z',
      behind_count: 0,
      refresh_status: 'up_to_date',
      active_absorbed_capabilities: ['pm-frame'],
    },
    {
      name: 'superpowers',
      repo_url: 'https://github.com/obra/superpowers.git',
      pinned_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      bootstrap_state: 'checked',
      last_checked_commit: 'cccccccccccccccccccccccccccccccccccccccc',
      last_checked_at: '2026-04-30T00:00:00.000Z',
      behind_count: 2,
      refresh_status: 'behind',
      active_absorbed_capabilities: ['superpowers-review'],
    },
  ],
} as const;

const UPSTREAM_README_FIXTURE = [
  '# Upstream Sources',
  '',
  'Source records are mirrored in vendor/upstream-notes/upstream-lock.json.',
  'Freshness summaries are mirrored in vendor/upstream-notes/update-status.md.',
  'Each entry is a bootstrap snapshot until a maintainer check records it as checked.',
  '',
  '- `pm-skills`',
  '  - repo: `https://github.com/pingcap/pm-skills.git`',
  '  - pinned_commit: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`',
  '- `superpowers`',
  '  - repo: `https://github.com/obra/superpowers.git`',
  '  - pinned_commit: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`',
].join('\n');

const UPDATE_STATUS_FIXTURE = [
  '# Upstream Update Status',
  '',
  'Last checked: 2026-04-30T00:00:00.000Z',
  '',
  '| upstream | pinned | checked | behind | capabilities | triage |',
  '|---|---|---|---|---|---|',
  '| pm-skills | `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | 0 | `pm-frame` | `ignore` |',
  '| superpowers | `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` | `cccccccccccccccccccccccccccccccccccccccc` | 2 | `superpowers-review` | `refresh_now` |',
].join('\n');

function parseInventory(markdown: string): Array<Record<string, string>> {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));

  if (lines.length < 3) {
    throw new Error('Inventory table is missing');
  }

  const headers = lines[0]
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  const rows = lines.slice(2).filter((line) => !/^\|\s*-/.test(line));

  return rows.map((line) => {
    const values = line
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);

    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function parseCsvField(value: string): string[] {
  return value
    .split(',')
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function parseUpstreamReadme(markdown: string): Array<{ name: string; repo_url: string; pinned_commit: string }> {
  const normalizedMarkdown = markdown.replace(/\r\n?/g, '\n');
  const matches = [...normalizedMarkdown.matchAll(/- `([^`]+)`\n\s+- repo: `([^`]+)`\n\s+- pinned_commit: `([^`]+)`/g)];

  return matches.map((match) => ({
    name: match[1],
    repo_url: match[2],
    pinned_commit: match[3],
  }));
}

describe('nexus inventories', () => {
  test('shared compatibility contract exposes final removed vs historical legacy surface', () => {
    expect(COMPATIBILITY_SURFACE_STATUSES).toEqual({
      removed_from_active_path: 'removed_from_active_path',
      historical_record_only: 'historical_record_only',
    });

    expect(COMPATIBILITY_SURFACES.length).toBe(
      REMOVED_COMPATIBILITY_BOUNDARY_SHIMS.length +
        REMOVED_LEGACY_RUNTIME_IDENTITIES.length +
        HISTORICAL_LEGACY_REFERENCES.length,
    );
  });

  test.each(INVENTORIES)('%s includes populated mandatory fields', (path) => {
    const markdown = readFileSync(path, 'utf8');
    const rows = parseInventory(markdown);

    for (const field of MANDATORY_FIELDS) {
      expect(markdown).toContain(field);
      for (const row of rows) {
        expect(row[field]).not.toBe('');
      }
    }
  });

  test.each(IMPORTED_SOURCE_INVENTORIES)('%s includes populated upstream provenance fields', (path) => {
    const markdown = readFileSync(path, 'utf8');
    const rows = parseInventory(markdown);

    for (const field of PROVENANCE_FIELDS) {
      expect(markdown).toContain(field);
      for (const row of rows) {
        expect(row[field]).not.toBe('');
      }
    }

    for (const row of rows) {
      expect(row.upstream_repo_url).toMatch(/^https:\/\/github\.com\/.+\.git$/);
      expect(row.pinned_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(row.imported_path.startsWith('vendor/upstream/')).toBe(true);
      expect(row.imported_path).toMatch(/^vendor\/upstream\/[^/]+/);
    }
  });

  test.each(IMPORTED_SOURCE_INVENTORIES)('%s links active rows to Nexus-owned stage packs', (path) => {
    const markdown = readFileSync(path, 'utf8');
    const rows = parseInventory(markdown);

    expect(markdown).toContain('nexus_stage_packs');

    for (const row of rows) {
      if (row.milestone_state !== 'integrating' && row.milestone_state !== 'verified') {
        continue;
      }

      const packIds = parseCsvField(row.nexus_stage_packs ?? '');
      if (packIds.length === 0) {
        continue;
      }

      for (const packId of packIds) {
        expect(NEXUS_STAGE_PACKS.includes(packId as (typeof NEXUS_STAGE_PACKS)[number])).toBe(true);
      }
    }
  });

  test('legacy host migration history marks active removal complete and leaves legacy only as history', () => {
    const markdown = readFileSync('vendor/upstream-notes/legacy-host-migration-history.md', 'utf8');
    const rows = parseInventory(markdown);

    expect(markdown).toContain('Milestone 11 final state');
    expect(markdown).toContain('removed_from_active_path');
    expect(markdown).toContain('historical_record_only');
    expect(markdown).not.toContain('retained_compatibility_shim');
    expect(markdown).not.toContain('deferred_final_removal');

    for (const surface of REMOVED_COMPATIBILITY_BOUNDARY_SHIMS) {
      expect(markdown).toContain(surface);
    }
    for (const surface of REMOVED_LEGACY_RUNTIME_IDENTITIES) {
      expect(markdown).toContain(surface);
    }
    for (const surface of HISTORICAL_LEGACY_REFERENCES) {
      expect(markdown).toContain(surface);
    }

    for (const row of rows) {
      expect(row.cleanup_phase).toBe('completed_m11');
      expect(`${row.normalization_required} ${row.notes}`.toLowerCase()).toMatch(
        /host only|removed from active path|historical only|no governed writeback/,
      );
    }
  });
});

describe('nexus docs describe absorbed upstreams as source material', () => {
  test('absorption status locks Nexus-owned stage packs as the active units', () => {
    const markdown = readFileSync('vendor/upstream-notes/absorption-status.md', 'utf8');

    expect(markdown).toContain('Nexus-owned stage packs');
    expect(markdown).toContain('source material only');
    expect(markdown).toContain('`~/.nexus` is now the primary host support state root');
    expect(markdown).toContain('`.nexus-worktrees` and `~/.nexus-dev` are now the primary developer substrate roots');
    expect(markdown).toContain('`nexus-*` host helpers are the active entrypoints');
    expect(markdown).toContain('`gstack` now survives only in archived records');
    expect(markdown).not.toContain('`gstack-*` host binaries still work as shims');
  });

  test.each(SURFACE_DOCS)('%s keeps upstream identity secondary to Nexus stage packs', (path) => {
    const markdown = readFileSync(path, 'utf8');

    expect(markdown).toContain('Nexus-owned stage packs');
    expect(markdown).toContain('source material');
  });

  test('upstream README fixture stays aligned with checked maintenance lock and status summary fixtures', () => {
    const readme = UPSTREAM_README_FIXTURE;
    const lock = UPSTREAM_LOCK_FIXTURE;
    const readmeEntries = parseUpstreamReadme(readme);
    const updateStatus = UPDATE_STATUS_FIXTURE;

    expect(readme).toContain('vendor/upstream-notes/upstream-lock.json');
    expect(readme).toContain('vendor/upstream-notes/update-status.md');
    expect(readme).toContain('bootstrap snapshot');
    expect(readmeEntries).toHaveLength(lock.upstreams.length);
    expect(updateStatus).toContain('Last checked:');
    expect(updateStatus).not.toContain('No upstream checks have run yet.');
    expect(updateStatus).not.toContain('Bootstrap Snapshot');

    const readmeByName = new Map(readmeEntries.map((entry) => [entry.name, entry]));

    for (const record of lock.upstreams) {
      const capabilities = record.active_absorbed_capabilities.map((capability) => `\`${capability}\``).join(', ');
      const triage =
        record.last_checked_commit === null
          ? 'defer'
          : record.behind_count === null
            ? 'defer'
            : record.behind_count === 0
            ? 'ignore'
            : record.behind_count > 1
              ? 'refresh_now'
              : 'review';

      expect(record.bootstrap_state).toBe('checked');
      expect(readmeByName.get(record.name)).toEqual({
        name: record.name,
        repo_url: record.repo_url,
        pinned_commit: record.pinned_commit,
      });
      expect(updateStatus).toContain(
        `| ${record.name} | \`${record.pinned_commit}\` | \`${record.last_checked_commit}\` | ${record.behind_count} | ${capabilities} | \`${triage}\` |`,
      );
    }
  });
});

describe('nexus runtime activation authority', () => {
  test('governed tail seams remain active in the runtime registry', () => {
    const registry = getDefaultAdapterRegistry();

    expect(registry.review.superpowers).toBe('active');
    expect(registry.review.ccb).toBe('active');
    expect(registry.qa.ccb).toBe('active');
    expect(registry.ship.superpowers).toBe('active');
    expect(registry.ship.local).toBe('active');
    expect(registry.build.superpowers).toBe('active');
    expect(registry.build.ccb).toBe('active');
    expect(registry.handoff.ccb).toBe('active');
  });
});
