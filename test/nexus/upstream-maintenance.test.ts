import { describe, expect, test } from 'bun:test';
import {
  UPSTREAM_ABSORPTION_DECISIONS,
  UPSTREAM_BOOTSTRAP_STATES,
  UPSTREAM_MAINTENANCE_UPSTREAMS,
  UPSTREAM_NAMES,
  UPSTREAM_REFRESH_STATUSES,
  createInitialUpstreamLock,
  getUpstreamImportedPath,
  getUpstreamInventoryPath,
  getUpstreamPinnedCommit,
  getUpstreamRepoUrl,
} from '../../lib/nexus/upstream-maintenance';

type UpstreamLock = ReturnType<typeof createInitialUpstreamLock>;
type UpstreamLockRecord = UpstreamLock['upstreams'][number];

const CHECKED_AT = '2026-04-30T00:00:00.000Z';
const CHECKED_COMMITS = [
  UPSTREAM_MAINTENANCE_UPSTREAMS[0].pinned_commit,
  '1111111111111111111111111111111111111111',
  '2222222222222222222222222222222222222222',
  '3333333333333333333333333333333333333333',
] as const;

function formatCapabilities(capabilities: readonly string[]): string {
  return capabilities.map((capability) => `\`${capability}\``).join(', ');
}

function expectedTriage(record: { last_checked_commit: string | null; behind_count: number | null }): 'ignore' | 'defer' | 'review' | 'refresh_now' {
  if (record.last_checked_commit === null) return 'defer';
  if (record.behind_count === null) return 'defer';
  if (record.behind_count === 0) return 'ignore';
  return record.behind_count > 1 ? 'refresh_now' : 'review';
}

function createCheckedUpstreamLockFixture(): UpstreamLock {
  const lock = createInitialUpstreamLock(CHECKED_AT);

  return {
    ...lock,
    upstreams: lock.upstreams.map((record, index): UpstreamLockRecord => {
      const lastCheckedCommit = CHECKED_COMMITS[index] ?? record.pinned_commit;
      const behindCount = lastCheckedCommit === record.pinned_commit ? 0 : index;

      return {
        ...record,
        bootstrap_state: 'checked',
        last_checked_commit: lastCheckedCommit,
        last_checked_at: CHECKED_AT,
        behind_count: behindCount,
        refresh_status: behindCount === 0 ? 'up_to_date' : 'behind',
        last_absorption_decision: behindCount === 0 ? 'ignore' : 'defer',
        notes:
          behindCount === 0
            ? 'checked snapshot; reviewed and ignored; non-authoritative source material only'
            : 'checked snapshot; reviewed and deferred; non-authoritative source material only',
      };
    }),
  };
}

function renderUpdateStatusFixture(lock: UpstreamLock): string {
  const rows = lock.upstreams
    .map(
      (record) =>
        `| ${record.name} | \`${record.pinned_commit}\` | \`${record.last_checked_commit}\` | ${record.behind_count} | ${formatCapabilities(record.active_absorbed_capabilities)} | \`${expectedTriage(record)}\` |`,
    )
    .join('\n');

  return [
    '# Upstream Update Status',
    '',
    `Last checked: ${lock.updated_at}`,
    '',
    '| upstream | pinned | checked | behind | capabilities | triage |',
    '|---|---|---|---|---|---|',
    rows,
    '',
  ].join('\n');
}

describe('nexus upstream maintenance contract', () => {
  test('exports the four frozen upstreams with helper paths', () => {
    expect(UPSTREAM_NAMES).toEqual(['pm-skills', 'gsd', 'superpowers', 'claude-code-bridge']);
    expect(UPSTREAM_REFRESH_STATUSES).toEqual(['unchecked', 'up_to_date', 'behind', 'refresh_candidate']);
    expect(UPSTREAM_ABSORPTION_DECISIONS).toEqual(['ignore', 'defer', 'absorb_partial', 'absorb_full', 'reject']);
    expect(UPSTREAM_BOOTSTRAP_STATES).toEqual(['bootstrap', 'checked']);
    expect(UPSTREAM_MAINTENANCE_UPSTREAMS).toHaveLength(4);

    for (const upstream of UPSTREAM_MAINTENANCE_UPSTREAMS) {
      expect(getUpstreamRepoUrl(upstream.name)).toBe(upstream.repo_url);
      expect(getUpstreamPinnedCommit(upstream.name)).toBe(upstream.pinned_commit);
      expect(getUpstreamImportedPath(upstream.name)).toBe(upstream.imported_path);
      expect(getUpstreamInventoryPath(upstream.name)).toBe(upstream.inventory_path);
    }
  });

  test('creates a lock snapshot that keeps upstreams as source material only', () => {
    const lock = createInitialUpstreamLock('2026-04-09T00:00:00.000Z');

    expect(lock.schema_version).toBe(1);
    expect(lock.updated_at).toBe('2026-04-09T00:00:00.000Z');
    expect(lock.upstreams).toHaveLength(4);

    for (const record of lock.upstreams) {
      expect(record.bootstrap_state).toBe('bootstrap');
      expect(record.last_checked_commit).toBeNull();
      expect(record.last_checked_at).toBeNull();
      expect(record.behind_count).toBeNull();
      expect(record.refresh_status).toBe('unchecked');
      expect(record.last_absorption_decision).toBeNull();
      expect(record.last_refresh_candidate_at).toBeNull();
      expect(record.notes.toLowerCase()).toContain('bootstrap snapshot only');
      expect(record.notes).toContain('non-authoritative');
      expect(record.notes).not.toMatch(/runtime truth/i);
      expect(Object.values(record).join(' ')).not.toMatch(/runtime truth/i);
    }
  });

  test('a checked lock fixture mirrors the frozen contract and checked state', () => {
    const lock = createCheckedUpstreamLockFixture();

    expect(lock.schema_version).toBe(1);
    expect(lock.upstreams).toHaveLength(4);
    expect(lock.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const byName = new Map(lock.upstreams.map((record) => [record.name, record]));

    for (const definition of UPSTREAM_MAINTENANCE_UPSTREAMS) {
      const record = byName.get(definition.name);

      expect(record).toBeDefined();
      expect(record).toMatchObject({
        name: definition.name,
        repo_url: definition.repo_url,
        imported_path: definition.imported_path,
        pinned_commit: definition.pinned_commit,
        bootstrap_state: 'checked',
      });
      expect(record?.active_absorbed_capabilities).toEqual([...definition.active_absorbed_capabilities]);
      expect(record?.refresh_status).toMatch(/^(unchecked|up_to_date|behind|refresh_candidate)$/);
      if (record?.refresh_status === 'refresh_candidate') {
        expect(record?.last_refresh_candidate_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(record?.last_absorption_decision).toBeNull();
      } else {
        expect(record?.last_refresh_candidate_at).toBeNull();
        expect(record?.last_absorption_decision === null || UPSTREAM_ABSORPTION_DECISIONS.includes(record?.last_absorption_decision)).toBe(
          true,
        );
      }
      expect(record?.last_checked_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(record?.last_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      if (record?.last_checked_commit === definition.pinned_commit) {
        expect(record?.behind_count).toBe(0);
        expect(['up_to_date', 'refresh_candidate']).toContain(record?.refresh_status);
      } else {
        expect(record?.behind_count).not.toBeNull();
        expect(record?.refresh_status).toBe('behind');
      }
      expect(record?.notes.toLowerCase()).toMatch(/checked snapshot|reviewed and ignored|reviewed and deferred/);
      expect(record?.notes).toContain('non-authoritative');
      expect(record?.notes).not.toContain('bootstrap snapshot only');
      expect(Object.values(record).join(' ')).not.toMatch(/runtime truth/i);
    }
  });

  test('checked lock and update-status fixtures agree on checked state and freshness values', () => {
    const lock = createCheckedUpstreamLockFixture();
    const status = renderUpdateStatusFixture(lock);

    expect(status).toContain('Last checked:');
    expect(status).not.toContain('No upstream checks have run yet.');
    expect(status).not.toContain('Bootstrap Snapshot');

    for (const record of lock.upstreams) {
      expect(status).toContain(
        `| ${record.name} | \`${record.pinned_commit}\` | \`${record.last_checked_commit}\` | ${record.behind_count} | ${formatCapabilities(record.active_absorbed_capabilities)} | \`${expectedTriage(record)}\` |`,
      );
      expect(record.bootstrap_state).toBe('checked');
      expect(record.last_checked_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(record.last_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record.behind_count === null || typeof record.behind_count === 'number').toBe(true);
      if (record.refresh_status === 'refresh_candidate') {
        expect(record.last_absorption_decision).toBeNull();
      } else {
        expect(record.last_absorption_decision === null || UPSTREAM_ABSORPTION_DECISIONS.includes(record.last_absorption_decision)).toBe(
          true,
        );
      }
    }
  });
});
