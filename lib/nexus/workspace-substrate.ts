import { spawnSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getPrimaryWorktreeRoot } from './support-surface';
import type { SessionRootRecord, WorkspaceRecord } from './types';

const LEGACY_WORKTREE_ROOT = '.worktrees';
export const RUN_WORKSPACE_SYNC_PATHS = [
  '.planning/current',
  '.planning/audits/current',
  '.planning/nexus/current-run.json',
  'docs/product',
] as const;
export type RunWorkspaceSyncPath = (typeof RUN_WORKSPACE_SYNC_PATHS)[number];
const RUN_WORKSPACE_SYNC_PATH_SET = new Set<string>(RUN_WORKSPACE_SYNC_PATHS);

type GitWorktreeEntry = {
  path: string;
  branch: string | null;
};

type GitStatusEntry = {
  code: string;
  path: string;
};

type RemotePrimaryBranch = {
  remote: string;
  branch: string;
  ref: string;
};

export function isRunWorkspaceSyncPath(relativePath: string): relativePath is RunWorkspaceSyncPath {
  return RUN_WORKSPACE_SYNC_PATH_SET.has(relativePath);
}

export function assertRunWorkspaceSyncPath(relativePath: string): asserts relativePath is RunWorkspaceSyncPath {
  if (!isRunWorkspaceSyncPath(relativePath)) {
    throw new Error(`Refusing to sync non-allowlisted run workspace path: ${relativePath}`);
  }
}

function gitStdout(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    timeout: 15_000,
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.toString('utf8');
}

function gitExitCode(cwd: string, args: string[]): number {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    timeout: 15_000,
  });
  return result.status ?? 1;
}

function gitSucceeds(cwd: string, args: string[]): boolean {
  return gitExitCode(cwd, args) === 0;
}

function gitResult(cwd: string, args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    timeout: 15_000,
  });
}

function normalizeBranch(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value === 'HEAD' || value === 'detached') {
    return null;
  }

  return value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
}

function currentBranch(cwd: string): string | null {
  return normalizeBranch(gitStdout(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? null);
}

function parseRemotePrimaryBranch(repoRoot: string): RemotePrimaryBranch | null {
  const raw = gitStdout(repoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD'])?.trim() ?? null;
  if (!raw) {
    return null;
  }

  const match = raw.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  if (!match) {
    return null;
  }

  return {
    remote: match[1]!,
    branch: match[2]!,
    ref: raw,
  };
}

function fetchRemotePrimaryBranch(repoRoot: string, remotePrimary: RemotePrimaryBranch): void {
  gitResult(repoRoot, ['fetch', '--quiet', remotePrimary.remote, remotePrimary.branch]);
}

function gitRevision(cwd: string, ref: string): string | null {
  return gitStdout(cwd, ['rev-parse', ref])?.trim() ?? null;
}

function gitRefIsAncestor(cwd: string, left: string, right: string): boolean {
  return gitSucceeds(cwd, ['merge-base', '--is-ancestor', left, right]);
}

function gitCommonDir(cwd: string): string | null {
  const raw = gitStdout(cwd, ['rev-parse', '--git-common-dir'])?.trim();
  if (!raw) {
    return null;
  }

  return resolve(cwd, raw);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function syncRepoPathIntoWorkspace(
  repoRoot: string,
  workspacePath: string,
  relativePath: string,
): void {
  assertRunWorkspaceSyncPath(relativePath);
  const sourcePath = join(repoRoot, relativePath);
  const targetPath = join(workspacePath, relativePath);

  rmSync(targetPath, { recursive: true, force: true });

  if (!existsSync(sourcePath)) {
    return;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath, {
    force: true,
    recursive: true,
  });
}

function parsePorcelainPath(value: string): string {
  const trimmed = value.trim();
  const renameSeparator = ' -> ';
  const target = trimmed.includes(renameSeparator)
    ? trimmed.slice(trimmed.lastIndexOf(renameSeparator) + renameSeparator.length)
    : trimmed;

  if (target.startsWith('"') && target.endsWith('"')) {
    try {
      return JSON.parse(target);
    } catch {
      return target.slice(1, -1);
    }
  }

  return target;
}

function gitStatusEntries(cwd: string): GitStatusEntry[] {
  const porcelain = gitStdout(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (porcelain === null) {
    return [];
  }

  return porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2),
      path: parsePorcelainPath(line.slice(3)),
    }));
}

function isMirroredRunArtifactPath(relativePath: string): boolean {
  return relativePath === '.planning/nexus/current-run.json'
    || relativePath.startsWith('.planning/current/')
    || relativePath.startsWith('.planning/audits/current/')
    || relativePath === 'docs/product'
    || relativePath.startsWith('docs/product/');
}

function hasOnlyMirroredRunArtifactsDirty(workspacePath: string): boolean {
  const entries = gitStatusEntries(workspacePath);
  return entries.length > 0 && entries.every((entry) => isMirroredRunArtifactPath(entry.path));
}

function clearMirroredRunArtifacts(workspacePath: string): void {
  for (const entry of gitStatusEntries(workspacePath)) {
    if (!isMirroredRunArtifactPath(entry.path)) {
      continue;
    }

    if (entry.code === '??') {
      rmSync(join(workspacePath, entry.path), { recursive: true, force: true });
      continue;
    }

    spawnSync('git', ['-C', workspacePath, 'restore', '--staged', '--worktree', '--source=HEAD', '--', entry.path], {
      stdio: 'pipe',
      timeout: 15_000,
    });
  }
}

export function resolveRepositoryRoot(cwd: string): string {
  const commonDir = gitCommonDir(cwd);
  if (commonDir) {
    const normalizedCommonDir = canonicalPath(commonDir);
    if (normalizedCommonDir.endsWith('/.git')) {
      return canonicalPath(dirname(normalizedCommonDir));
    }
  }

  const topLevel = gitStdout(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (topLevel) {
    return canonicalPath(topLevel);
  }

  return canonicalPath(cwd);
}

function parseWorktreeList(stdout: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current) {
        entries.push(current);
      }
      current = {
        path: line.slice('worktree '.length),
        branch: null,
      };
      continue;
    }

    if (line.startsWith('branch ') && current) {
      current.branch = normalizeBranch(line.slice('branch '.length));
      continue;
    }

    if (line === 'detached' && current) {
      current.branch = null;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

function preferredWorktreeSource(
  repoRoot: string,
  candidatePath: string,
): WorkspaceRecord['source'] | null {
  const normalizedCandidate = canonicalPath(candidatePath);
  const normalizedPrimaryRoot = canonicalPath(getPrimaryWorktreeRoot(repoRoot));
  const normalizedLegacyRoot = canonicalPath(join(repoRoot, LEGACY_WORKTREE_ROOT));

  if (
    normalizedCandidate === normalizedPrimaryRoot
    || normalizedCandidate.startsWith(`${normalizedPrimaryRoot}/`)
  ) {
    return 'existing:nexus_worktree';
  }

  if (
    normalizedCandidate === normalizedLegacyRoot
    || normalizedCandidate.startsWith(`${normalizedLegacyRoot}/`)
  ) {
    return 'existing:legacy_worktree';
  }

  return null;
}

function isWorkspaceUsable(repoRoot: string, workspacePath: string): boolean {
  if (!existsSync(workspacePath)) {
    return false;
  }

  const repoCommonDir = gitCommonDir(repoRoot);
  const workspaceCommonDir = gitCommonDir(workspacePath);
  return repoCommonDir !== null
    && workspaceCommonDir !== null
    && canonicalPath(repoCommonDir) === canonicalPath(workspaceCommonDir);
}

function isRegisteredWorktree(repoRoot: string, workspacePath: string): boolean {
  const worktreeList = gitStdout(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!worktreeList) {
    return false;
  }

  const normalizedWorkspacePath = canonicalPath(workspacePath);
  return parseWorktreeList(worktreeList)
    .some((entry) => canonicalPath(entry.path) === normalizedWorkspacePath);
}

function isCleanWorktree(workspacePath: string): boolean {
  const porcelain = gitStdout(workspacePath, ['status', '--porcelain']);
  return porcelain !== null && porcelain.trim() === '';
}

function candidateRank(repoRoot: string, candidate: GitWorktreeEntry): [number, number, number, string] {
  const source = preferredWorktreeSource(repoRoot, candidate.path);
  const sourceRank = source === 'existing:nexus_worktree' ? 0 : 1;
  const implementRank = candidate.path.endsWith('/implement') ? 0 : 1;
  const branchRank = candidate.branch ? 0 : 1;
  return [sourceRank, implementRank, branchRank, candidate.path];
}

function sortCandidates(repoRoot: string, candidates: GitWorktreeEntry[]): GitWorktreeEntry[] {
  return [...candidates].sort((left, right) => {
    const leftRank = candidateRank(repoRoot, left);
    const rightRank = candidateRank(repoRoot, right);
    for (let index = 0; index < leftRank.length; index += 1) {
      const leftValue = leftRank[index]!;
      const rightValue = rightRank[index]!;
      if (leftValue < rightValue) {
        return -1;
      }
      if (leftValue > rightValue) {
        return 1;
      }
    }
    return 0;
  });
}

function rootWorkspace(repoRoot: string): WorkspaceRecord {
  return {
    path: canonicalPath(repoRoot),
    kind: 'root',
    branch: currentBranch(repoRoot),
    source: 'repo_root',
  };
}

function branchExists(repoRoot: string, branch: string): boolean {
  return gitExitCode(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]) === 0;
}

function freshRunBranch(runId: string): string {
  return `branch/${runId}`;
}

function isRunOwnedWorkspace(workspace: WorkspaceRecord): boolean {
  return workspace.kind === 'worktree'
    && (
      workspace.source === 'allocated:fresh_run'
      || workspace.run_id !== undefined
      || workspace.branch?.startsWith('branch/run-') === true
      || workspace.branch?.startsWith('codex/run-') === true
    );
}

function isGitRepository(repoRoot: string): boolean {
  const resolvedRoot = gitStdout(repoRoot, ['rev-parse', '--show-toplevel'])?.trim() ?? null;
  return resolvedRoot !== null;
}

function allocatedWorkspace(repoRoot: string, worktreePath: string, runId: string): WorkspaceRecord {
  return {
    path: canonicalPath(worktreePath),
    kind: 'worktree',
    branch: currentBranch(worktreePath) ?? freshRunBranch(runId),
    source: 'allocated:fresh_run',
    run_id: runId,
    retirement_state: 'active',
  };
}

export function resolveRepositoryPrimaryBranch(repoRoot: string): string {
  const remoteHead = normalizeBranch(gitStdout(repoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD'])?.trim() ?? null);
  return remoteHead ?? currentBranch(repoRoot) ?? 'main';
}

export function ensureFreshRunWorkspaceBaseline(
  repoRoot: string,
  workspace?: WorkspaceRecord | null,
): WorkspaceRecord | null {
  if (!workspace) {
    return null;
  }

  const resolvedRepoRoot = resolveRepositoryRoot(repoRoot);
  const normalizedWorkspace: WorkspaceRecord = {
    ...workspace,
    path: canonicalPath(workspace.path),
    branch: currentBranch(workspace.path) ?? workspace.branch,
  };

  if (
    !isRunOwnedWorkspace(normalizedWorkspace)
    || !isWorkspaceUsable(resolvedRepoRoot, normalizedWorkspace.path)
  ) {
    return normalizedWorkspace;
  }

  const remotePrimary = parseRemotePrimaryBranch(resolvedRepoRoot);
  if (remotePrimary) {
    fetchRemotePrimaryBranch(resolvedRepoRoot, remotePrimary);
  }

  const targetRef = remotePrimary?.ref ?? resolveRepositoryPrimaryBranch(resolvedRepoRoot);
  const workspaceHead = gitRevision(normalizedWorkspace.path, 'HEAD');
  const targetHead = gitRevision(resolvedRepoRoot, targetRef);
  if (!workspaceHead || !targetHead || workspaceHead === targetHead) {
    return {
      ...normalizedWorkspace,
      branch: currentBranch(normalizedWorkspace.path) ?? normalizedWorkspace.branch,
    };
  }

  if (gitRefIsAncestor(normalizedWorkspace.path, targetRef, 'HEAD')) {
    return {
      ...normalizedWorkspace,
      branch: currentBranch(normalizedWorkspace.path) ?? normalizedWorkspace.branch,
    };
  }

  if (!gitRefIsAncestor(normalizedWorkspace.path, 'HEAD', targetRef)) {
    throw new Error(
      `Fresh run workspace diverged from ${targetRef}; refresh the run workspace from the default branch before governed execution.`,
    );
  }

  if (!isCleanWorktree(normalizedWorkspace.path)) {
    if (!hasOnlyMirroredRunArtifactsDirty(normalizedWorkspace.path)) {
      throw new Error(
        `Fresh run workspace is behind ${targetRef} and has local changes outside mirrored run artifacts; sync the branch before governed execution.`,
      );
    }

    clearMirroredRunArtifacts(normalizedWorkspace.path);
  }

  if (!isCleanWorktree(normalizedWorkspace.path)) {
    throw new Error(
      `Fresh run workspace could not be cleaned for a fast-forward refresh from ${targetRef}; resolve local changes before governed execution.`,
    );
  }

  const mergeResult = gitResult(normalizedWorkspace.path, ['merge', '--ff-only', targetRef]);
  if ((mergeResult.status ?? 1) !== 0) {
    const stderr = mergeResult.stderr.toString('utf8').trim();
    const stdout = mergeResult.stdout.toString('utf8').trim();
    throw new Error(
      stderr || stdout || `Fresh run workspace could not fast-forward to ${targetRef} before governed execution.`,
    );
  }

  return {
    ...normalizedWorkspace,
    branch: currentBranch(normalizedWorkspace.path) ?? normalizedWorkspace.branch,
  };
}

export function resolveSessionRootRecord(repoRoot: string): SessionRootRecord {
  let current = resolveRepositoryRoot(repoRoot);

  while (true) {
    if (existsSync(join(current, '.ccb')) || existsSync(join(current, '.ccb_config'))) {
      return {
        path: current,
        kind: 'repo_root',
        source: 'ccb_root',
      };
    }

    const parent = dirname(current);
    if (parent === current) {
      return {
        path: resolveRepositoryRoot(repoRoot),
        kind: 'repo_root',
        source: 'ccb_root',
      };
    }

    current = parent;
  }
}

export function allocateFreshRunWorkspace(repoRoot: string, runId: string): WorkspaceRecord {
  const resolvedRepoRoot = resolveRepositoryRoot(repoRoot);
  if (!isGitRepository(resolvedRepoRoot)) {
    return rootWorkspace(resolvedRepoRoot);
  }

  const worktreeRoot = getPrimaryWorktreeRoot(resolvedRepoRoot);
  const worktreePath = join(worktreeRoot, runId);
  const branch = freshRunBranch(runId);

  if (isWorkspaceUsable(resolvedRepoRoot, worktreePath)) {
    return allocatedWorkspace(resolvedRepoRoot, worktreePath, runId);
  }

  mkdirSync(worktreeRoot, { recursive: true });

  const args = branchExists(resolvedRepoRoot, branch)
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', worktreePath, '-b', branch, resolveRepositoryPrimaryBranch(resolvedRepoRoot)];
  const result = spawnSync('git', ['-C', resolvedRepoRoot, ...args], {
    stdio: 'pipe',
    timeout: 15_000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr.toString('utf8').trim();
    const stdout = result.stdout.toString('utf8').trim();
    throw new Error(stderr || stdout || `failed to allocate fresh run workspace for ${runId}`);
  }

  return allocatedWorkspace(resolvedRepoRoot, worktreePath, runId);
}

export function retireRunWorkspace(workspace?: WorkspaceRecord | null): WorkspaceRecord | null {
  if (!workspace) {
    return null;
  }

  const normalizedWorkspace = {
    ...workspace,
    path: canonicalPath(workspace.path),
  };
  if (workspace.kind !== 'worktree') {
    return normalizedWorkspace;
  }

  if (workspace.source !== 'allocated:fresh_run') {
    return normalizedWorkspace;
  }

  return {
    ...normalizedWorkspace,
    retirement_state: 'retired_pending_cleanup',
  };
}

export function cleanupRetiredRunWorkspace(
  repoRoot: string,
  workspace?: WorkspaceRecord | null,
): WorkspaceRecord | null {
  if (!workspace) {
    return null;
  }

  const normalizedWorkspace = {
    ...workspace,
    path: canonicalPath(workspace.path),
  };
  if (normalizedWorkspace.kind !== 'worktree') {
    return normalizedWorkspace;
  }

  const resolvedRepoRoot = resolveRepositoryRoot(repoRoot);
  if (normalizedWorkspace.path === resolvedRepoRoot) {
    return {
      ...normalizedWorkspace,
      retirement_state: 'retained',
    };
  }

  if (normalizedWorkspace.source !== 'allocated:fresh_run') {
    return {
      ...normalizedWorkspace,
      retirement_state: 'retained',
    };
  }

  if (normalizedWorkspace.retirement_state !== 'retired_pending_cleanup') {
    return normalizedWorkspace;
  }

  const primaryWorktreeRoot = canonicalPath(getPrimaryWorktreeRoot(resolvedRepoRoot));
  if (
    normalizedWorkspace.path !== primaryWorktreeRoot
    && !normalizedWorkspace.path.startsWith(`${primaryWorktreeRoot}/`)
  ) {
    return {
      ...normalizedWorkspace,
      retirement_state: 'retained',
    };
  }

  if (!existsSync(normalizedWorkspace.path)) {
    return {
      ...normalizedWorkspace,
      retirement_state: 'removed',
    };
  }

  if (!isWorkspaceUsable(resolvedRepoRoot, normalizedWorkspace.path)) {
    return {
      ...normalizedWorkspace,
      retirement_state: 'retained',
    };
  }

  if (!isRegisteredWorktree(resolvedRepoRoot, normalizedWorkspace.path)) {
    return {
      ...normalizedWorkspace,
      retirement_state: 'retained',
    };
  }

  if (!isCleanWorktree(normalizedWorkspace.path)) {
    if (!hasOnlyMirroredRunArtifactsDirty(normalizedWorkspace.path)) {
      return {
        ...normalizedWorkspace,
        retirement_state: 'retained',
      };
    }

    clearMirroredRunArtifacts(normalizedWorkspace.path);
  }

  if (!isCleanWorktree(normalizedWorkspace.path)) {
    return {
      ...normalizedWorkspace,
      retirement_state: 'retained',
    };
  }

  if (gitSucceeds(resolvedRepoRoot, ['worktree', 'remove', normalizedWorkspace.path]) || !existsSync(normalizedWorkspace.path)) {
    return {
      ...normalizedWorkspace,
      retirement_state: 'removed',
    };
  }

  return {
    ...normalizedWorkspace,
    retirement_state: 'retained',
  };
}

export function syncRunWorkspaceArtifacts(
  repoRoot: string,
  workspace?: WorkspaceRecord | null,
): void {
  if (!workspace || workspace.kind !== 'worktree') {
    return;
  }

  const resolvedRepoRoot = resolveRepositoryRoot(repoRoot);
  const normalizedWorkspacePath = canonicalPath(workspace.path);
  if (normalizedWorkspacePath === resolvedRepoRoot) {
    return;
  }

  if (!isWorkspaceUsable(resolvedRepoRoot, normalizedWorkspacePath)) {
    return;
  }

  for (const relativePath of RUN_WORKSPACE_SYNC_PATHS) {
    syncRepoPathIntoWorkspace(resolvedRepoRoot, normalizedWorkspacePath, relativePath);
  }
}

export function resolveExecutionWorkspace(
  repoRoot: string,
  existingWorkspace?: WorkspaceRecord | null,
): WorkspaceRecord {
  const resolvedRepoRoot = resolveRepositoryRoot(repoRoot);

  if (existingWorkspace && isWorkspaceUsable(resolvedRepoRoot, existingWorkspace.path)) {
    return {
      ...existingWorkspace,
      path: canonicalPath(existingWorkspace.path),
      branch: currentBranch(existingWorkspace.path),
    };
  }

  const worktreeList = gitStdout(resolvedRepoRoot, ['worktree', 'list', '--porcelain']);
  if (!worktreeList) {
    return rootWorkspace(resolvedRepoRoot);
  }

  const candidates = parseWorktreeList(worktreeList)
    .filter((entry) => canonicalPath(entry.path) !== resolvedRepoRoot)
    .filter((entry) => preferredWorktreeSource(resolvedRepoRoot, entry.path) !== null)
    .filter((entry) => isWorkspaceUsable(resolvedRepoRoot, entry.path));

  if (candidates.length === 0) {
    return rootWorkspace(resolvedRepoRoot);
  }

  const selected = sortCandidates(resolvedRepoRoot, candidates)[0]!;
  return {
    path: canonicalPath(selected.path),
    kind: 'worktree',
    branch: currentBranch(selected.path) ?? selected.branch,
    source: preferredWorktreeSource(resolvedRepoRoot, selected.path) ?? 'existing:legacy_worktree',
  };
}
