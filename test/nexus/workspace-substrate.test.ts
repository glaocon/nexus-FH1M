import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, test } from 'bun:test';
import { resolveInvocation } from '../../lib/nexus/commands/index';
import { getDefaultNexusAdapters } from '../../lib/nexus/adapters/registry';
import type { NexusAdapters } from '../../lib/nexus/adapters/types';
import type { ExecutionSelection } from '../../lib/nexus/execution-topology';
import {
  allocateFreshRunWorkspace,
  assertRunWorkspaceSyncPath,
  isRunWorkspaceSyncPath,
  RUN_WORKSPACE_SYNC_PATHS,
  resolveExecutionWorkspace,
  resolveSessionRootRecord,
  syncRunWorkspaceArtifacts,
} from '../../lib/nexus/workspace-substrate';
import { makeFakeAdapters } from './helpers/fake-adapters';

type TempRepoRun = {
  run: (command: string, adapters?: NexusAdapters, execution?: ExecutionSelection) => Promise<void>;
  readJson: (path: string) => any;
  readFile: (path: string) => string;
  cwd: string;
};

type SeenCall = {
  stage: string;
  cwd: string;
  workspace: unknown;
};

function createTempGitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'nexus-workspace-'));
  mkdirSync(join(cwd, '.planning'), { recursive: true });
  writeFileSync(join(cwd, 'README.md'), '# temp repo\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd, stdio: 'pipe' });
  spawnSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
  return cwd;
}

function createLinkedWorktree(
  repoRoot: string,
  worktreeRoot: '.nexus-worktrees' | '.worktrees',
  name = 'implement',
  branch = 'feature/implement',
): string {
  const base = join(repoRoot, worktreeRoot);
  mkdirSync(base, { recursive: true });
  spawnSync('git', ['branch', branch], { cwd: repoRoot, stdio: 'pipe' });
  const worktreePath = join(base, name);
  const result = spawnSync('git', ['worktree', 'add', worktreePath, branch], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'failed to create linked worktree');
  }

  return worktreePath;
}

async function runInTempGitRepo(
  fn: (ctx: TempRepoRun) => Promise<void>,
): Promise<void> {
  const cwd = createTempGitRepo();

  const run = async (
    command: string,
    adapters = getDefaultNexusAdapters(),
    execution: ExecutionSelection = {
      mode: 'governed_ccb',
      primary_provider: 'codex',
      provider_topology: 'multi_session',
      requested_execution_path: 'codex-via-ccb',
    },
  ) => {
    const invocation = resolveInvocation(command);
    await invocation.handler({
      cwd,
      clock: () => new Date().toISOString(),
      via: invocation.via,
      adapters,
      execution,
    });
  };

  try {
    await fn({
      cwd,
      run,
      readJson: (path: string) => JSON.parse(readFileSync(join(cwd, path), 'utf8')),
      readFile: (path: string) => readFileSync(join(cwd, path), 'utf8'),
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function governedAdapters(seen: SeenCall[]): NexusAdapters {
  return makeFakeAdapters({
    ccb: {
      resolve_route: async (ctx) => {
        seen.push({ stage: 'handoff', cwd: ctx.cwd, workspace: ctx.workspace });
        return {
          adapter_id: 'ccb',
          outcome: 'success',
          raw_output: {
            available: true,
            provider: 'codex',
            providers: ['codex', 'gemini'],
            mounted: ['codex', 'gemini'],
            provider_checks: [
              {
                provider: 'codex',
                ping_command: 'ccb-ping codex',
                ping_output: '✅ codex connection OK (Session healthy)',
              },
              {
                provider: 'gemini',
                ping_command: 'ccb-ping gemini',
                ping_output: '✅ gemini connection OK (Session healthy)',
              },
            ],
          },
          requested_route: ctx.requested_route,
          actual_route: {
            provider: 'codex',
            route: 'codex-via-ccb',
            substrate: 'superpowers-core',
            transport: 'ccb',
            receipt_path: '.planning/current/handoff/adapter-output.json',
          },
          notices: [],
          conflict_candidates: [],
        };
      },
      execute_generator: async (ctx) => {
        seen.push({ stage: 'build', cwd: ctx.cwd, workspace: ctx.workspace });
        return {
          adapter_id: 'ccb',
          outcome: 'success',
          raw_output: {
            receipt: 'ccb-build',
            summary_markdown: '# Build Execution Summary\n\n- Status: completed\n- Actions: Implemented bounded build.\n- Files touched: README.md\n- Verification: ok\n',
          },
          requested_route: ctx.requested_route,
          actual_route: {
            provider: 'codex',
            route: 'codex-via-ccb',
            substrate: 'superpowers-core',
            transport: 'ccb',
            receipt_path: '.planning/current/build/adapter-output.json',
          },
          notices: [],
          conflict_candidates: [],
        };
      },
      execute_audit_a: async (ctx) => {
        seen.push({ stage: 'review-codex', cwd: ctx.cwd, workspace: ctx.workspace });
        return {
          adapter_id: 'ccb',
          outcome: 'success',
          raw_output: {
            markdown: '# Codex Audit\n\nResult: pass\n\nFindings:\n- none\n',
            receipt: 'ccb-review-codex',
          },
          requested_route: ctx.requested_route,
          actual_route: {
            provider: 'codex',
            route: 'codex-via-ccb',
            substrate: 'superpowers-core',
            transport: 'ccb',
            receipt_path: '.planning/current/review/adapter-output.json',
          },
          notices: [],
          conflict_candidates: [],
        };
      },
      execute_audit_b: async (ctx) => {
        seen.push({ stage: 'review-gemini', cwd: ctx.cwd, workspace: ctx.workspace });
        return {
          adapter_id: 'ccb',
          outcome: 'success',
          raw_output: {
            markdown: '# Gemini Audit\n\nResult: pass\n\nFindings:\n- none\n',
            receipt: 'ccb-review-gemini',
          },
          requested_route: ctx.requested_route,
          actual_route: {
            provider: 'gemini',
            route: 'gemini-via-ccb',
            substrate: 'superpowers-core',
            transport: 'ccb',
            receipt_path: '.planning/current/review/adapter-output.json',
          },
          notices: [],
          conflict_candidates: [],
        };
      },
      execute_qa: async (ctx) => {
        seen.push({ stage: 'qa', cwd: ctx.cwd, workspace: ctx.workspace });
        return {
          adapter_id: 'ccb',
          outcome: 'success',
          raw_output: {
            report_markdown: '# QA Report\n\nResult: pass\n',
            ready: true,
            findings: [],
            receipt: 'ccb-qa',
          },
          requested_route: ctx.requested_route,
          actual_route: {
            provider: 'gemini',
            route: 'gemini-via-ccb',
            substrate: 'superpowers-core',
            transport: 'ccb',
            receipt_path: '.planning/current/qa/adapter-output.json',
          },
          notices: [],
          conflict_candidates: [],
        };
      },
    },
    superpowers: {
      build_discipline: async (ctx) => {
        seen.push({ stage: 'build-discipline', cwd: ctx.cwd, workspace: ctx.workspace });
        return {
          adapter_id: 'superpowers',
          outcome: 'success',
          raw_output: {
            verification_summary: 'bounded build verified',
          },
          requested_route: null,
          actual_route: null,
          notices: [],
          conflict_candidates: [],
        };
      },
      review_discipline: async (ctx) => {
        seen.push({ stage: 'review-discipline', cwd: ctx.cwd, workspace: ctx.workspace });
        return {
          adapter_id: 'superpowers',
          outcome: 'success',
          raw_output: {
            discipline_summary: 'dual audit required',
          },
          requested_route: null,
          actual_route: null,
          notices: [],
          conflict_candidates: [],
        };
      },
      ship_discipline: async (ctx) => {
        seen.push({ stage: 'ship', cwd: ctx.cwd, workspace: ctx.workspace });
        return {
          adapter_id: 'superpowers',
          outcome: 'success',
          raw_output: {
            release_gate_record: '# Release Gate\n\nready\n',
            checklist: {
              review_complete: true,
              qa_ready: true,
              merge_ready: true,
            },
            merge_ready: true,
          },
          requested_route: null,
          actual_route: null,
          notices: [],
          conflict_candidates: [],
        };
      },
    },
  });
}

describe('nexus workspace substrate', () => {
  test('guards run workspace sync paths with an explicit allowlist', () => {
    expect([...RUN_WORKSPACE_SYNC_PATHS]).toEqual([
      '.planning/current',
      '.planning/audits/current',
      '.planning/nexus/current-run.json',
      'docs/product',
    ]);
    expect(isRunWorkspaceSyncPath('.planning/current')).toBe(true);
    expect(isRunWorkspaceSyncPath('docs/product')).toBe(true);
    expect(isRunWorkspaceSyncPath('.git/config')).toBe(false);
    expect(isRunWorkspaceSyncPath('../outside')).toBe(false);
    expect(() => assertRunWorkspaceSyncPath('.planning/current')).not.toThrow();
    expect(() => assertRunWorkspaceSyncPath('.git/config')).toThrow(
      'Refusing to sync non-allowlisted run workspace path',
    );
  });

  test('allocates a fresh run workspace under .nexus-worktrees instead of reusing a legacy implement worktree', async () => {
    await runInTempGitRepo(async ({ cwd }) => {
      const legacyWorktreePath = createLinkedWorktree(cwd, '.worktrees');

      const workspace = allocateFreshRunWorkspace(cwd, 'run-2026-04-13T00-00-00-000Z');

      expect(workspace).toMatchObject({
        path: realpathSync.native(join(cwd, '.nexus-worktrees', 'run-2026-04-13T00-00-00-000Z')),
        kind: 'worktree',
        branch: 'branch/run-2026-04-13T00-00-00-000Z',
        source: 'allocated:fresh_run',
        run_id: 'run-2026-04-13T00-00-00-000Z',
        retirement_state: 'active',
      });
      expect(workspace.path).not.toBe(realpathSync.native(legacyWorktreePath));
      expect(workspace.path).toContain(`${cwd}/.nexus-worktrees/`);
      expect(workspace.path).not.toContain(`${cwd}/.worktrees/`);
    });
  });

  test('anchors fresh-run allocation and session root to the repository root when invoked from a linked worktree', async () => {
    await runInTempGitRepo(async ({ cwd }) => {
      mkdirSync(join(cwd, '.ccb'), { recursive: true });
      const existingWorktreePath = createLinkedWorktree(cwd, '.nexus-worktrees', 'current-run', 'codex/current-run');

      const workspace = allocateFreshRunWorkspace(existingWorktreePath, 'run-2026-04-13T00-00-00-001Z');
      const sessionRoot = resolveSessionRootRecord(existingWorktreePath);

      expect(workspace).toMatchObject({
        path: realpathSync.native(join(cwd, '.nexus-worktrees', 'run-2026-04-13T00-00-00-001Z')),
        kind: 'worktree',
        branch: 'branch/run-2026-04-13T00-00-00-001Z',
        source: 'allocated:fresh_run',
        run_id: 'run-2026-04-13T00-00-00-001Z',
        retirement_state: 'active',
      });
      expect(workspace.path).not.toContain(`${existingWorktreePath}/.nexus-worktrees/`);
      expect(sessionRoot).toEqual({
        path: realpathSync.native(cwd),
        kind: 'repo_root',
        source: 'ccb_root',
      });
    });
  });

  test('resolves existing workspace candidates against the repository root when called from a linked worktree cwd', async () => {
    await runInTempGitRepo(async ({ cwd }) => {
      const currentRunPath = createLinkedWorktree(cwd, '.nexus-worktrees', 'current-run', 'codex/current-run');
      const implementPath = createLinkedWorktree(cwd, '.nexus-worktrees', 'implement', 'feature/implement');

      const workspace = resolveExecutionWorkspace(currentRunPath);

      expect(workspace).toEqual({
        path: realpathSync.native(implementPath),
        kind: 'worktree',
        branch: 'feature/implement',
        source: 'existing:nexus_worktree',
      });
    });
  });

  test('governed lifecycle selects a linked worktree workspace and persists provenance', async () => {
    await runInTempGitRepo(async ({ cwd, run, readJson }) => {
      const worktreePath = createLinkedWorktree(cwd, '.nexus-worktrees');
      const expectedCwd = realpathSync.native(cwd);
      const seen: SeenCall[] = [];
      const adapters = governedAdapters(seen);

      await run('plan');
      await run('handoff', adapters);
      await run('build', adapters);
      await run('review', adapters);
      await run('qa', adapters);
      await run('ship', adapters);

      const expectedWorkspace = {
        path: realpathSync.native(worktreePath),
        kind: 'worktree',
        branch: 'feature/implement',
        source: 'existing:nexus_worktree',
      };

      expect(readJson('.planning/nexus/current-run.json')).toMatchObject({
        execution: {
          workspace: expectedWorkspace,
        },
      });
      expect(readJson('.planning/current/handoff/status.json')).toMatchObject({ workspace: expectedWorkspace });
      expect(readJson('.planning/current/build/status.json')).toMatchObject({ workspace: expectedWorkspace });
      expect(readJson('.planning/current/review/status.json')).toMatchObject({ workspace: expectedWorkspace });
      expect(readJson('.planning/current/qa/status.json')).toMatchObject({ workspace: expectedWorkspace });
      expect(readJson('.planning/current/ship/status.json')).toMatchObject({ workspace: expectedWorkspace });

      expect(readJson('.planning/current/build/build-request.json')).toMatchObject({
        workspace: expectedWorkspace,
      });
      expect(readJson('.planning/current/review/adapter-request.json')).toMatchObject({
        workspace: expectedWorkspace,
      });
      expect(readJson('.planning/current/qa/adapter-request.json')).toMatchObject({
        workspace: expectedWorkspace,
      });
      expect(readJson('.planning/current/ship/adapter-request.json')).toMatchObject({
        workspace: expectedWorkspace,
      });

      expect(seen).toEqual([
        { stage: 'handoff', cwd: expectedCwd, workspace: expectedWorkspace },
        { stage: 'build-discipline', cwd: expectedCwd, workspace: expectedWorkspace },
        { stage: 'build', cwd: expectedCwd, workspace: expectedWorkspace },
        { stage: 'review-discipline', cwd: expectedCwd, workspace: expectedWorkspace },
        { stage: 'review-codex', cwd: expectedCwd, workspace: expectedWorkspace },
        { stage: 'review-gemini', cwd: expectedCwd, workspace: expectedWorkspace },
        { stage: 'qa', cwd: expectedCwd, workspace: expectedWorkspace },
        { stage: 'ship', cwd: expectedCwd, workspace: expectedWorkspace },
      ]);
    });
  });

  test('falls back to the repo root workspace when no linked worktree exists', async () => {
    await runInTempGitRepo(async ({ cwd, run, readJson }) => {
      const expectedCwd = realpathSync.native(cwd);
      const seen: SeenCall[] = [];
      const adapters = governedAdapters(seen);

      await run('plan');
      await run('handoff', adapters);

      const expectedWorkspace = {
        path: realpathSync.native(cwd),
        kind: 'root',
        branch: 'main',
        source: 'repo_root',
      };

      expect(readJson('.planning/nexus/current-run.json')).toMatchObject({
        execution: {
          workspace: expectedWorkspace,
        },
      });
      expect(readJson('.planning/current/handoff/status.json')).toMatchObject({
        workspace: expectedWorkspace,
      });
      expect(seen).toEqual([
        { stage: 'handoff', cwd: expectedCwd, workspace: expectedWorkspace },
      ]);
    });
  });

  test('mirrors current audit artifacts into the run-owned worktree', async () => {
    await runInTempGitRepo(async ({ cwd }) => {
      const workspace = allocateFreshRunWorkspace(cwd, 'run-2026-04-27T00-00-00-000Z');
      mkdirSync(join(cwd, '.planning/audits/current'), { recursive: true });
      writeFileSync(join(cwd, '.planning/audits/current/codex.md'), '# Codex Audit\n\nResult: pass\n');
      writeFileSync(join(cwd, '.planning/audits/current/gemini.md'), '# Gemini Audit\n\nResult: pass\n');
      writeFileSync(join(cwd, '.planning/audits/current/gate-decision.md'), 'Gate: pass\n');

      syncRunWorkspaceArtifacts(cwd, workspace);

      expect(readFileSync(join(workspace.path, '.planning/audits/current/codex.md'), 'utf8')).toContain('Codex Audit');
      expect(readFileSync(join(workspace.path, '.planning/audits/current/gemini.md'), 'utf8')).toContain('Gemini Audit');
      expect(readFileSync(join(workspace.path, '.planning/audits/current/gate-decision.md'), 'utf8')).toContain('Gate: pass');
    });
  });
});
