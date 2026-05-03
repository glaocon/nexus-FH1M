import type { PullRequestRecord } from './types';
import { runNexusCommand, type NexusCommandRunner } from './command-runner';
import { shellQuotePosix } from './shell-quote';
import { isRecord } from './validation-helpers';

interface GithubPullRequestPayload {
  number?: number;
  url?: string;
  state?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
}

function unavailablePullRequest(
  headBranch: string | null,
  reason: string,
  provider: PullRequestRecord['provider'] = 'github',
  headSha: string | null = null,
  baseBranch: string | null = null,
): PullRequestRecord {
  return {
    provider,
    status: 'unavailable',
    number: null,
    url: null,
    state: null,
    head_branch: headBranch,
    head_sha: headSha,
    base_branch: baseBranch,
    reason,
  };
}

function notRequestedPullRequest(reason: string): PullRequestRecord {
  return {
    provider: 'github',
    status: 'not_requested',
    number: null,
    url: null,
    state: null,
    head_branch: null,
    head_sha: null,
    base_branch: null,
    reason,
  };
}

function pushRequiredPullRequest(
  headBranch: string,
  headSha: string | null,
  baseBranch: string | null,
  remote: string,
  reason: string,
): PullRequestRecord {
  return {
    provider: 'github',
    status: 'push_required',
    number: null,
    url: null,
    state: null,
    head_branch: headBranch,
    head_sha: headSha,
    base_branch: baseBranch,
    reason,
    push_command: `git push -u ${shellQuotePosix(remote)} HEAD`,
  };
}

function fromGithubPayload(
  payload: GithubPullRequestPayload,
  status: PullRequestRecord['status'],
): PullRequestRecord {
  return {
    provider: 'github',
    status,
    number: typeof payload.number === 'number' ? payload.number : null,
    url: typeof payload.url === 'string' ? payload.url : null,
    state: typeof payload.state === 'string' ? payload.state : null,
    head_branch: typeof payload.headRefName === 'string' ? payload.headRefName : null,
    head_sha: typeof payload.headRefOid === 'string' ? payload.headRefOid : null,
    base_branch: typeof payload.baseRefName === 'string' ? payload.baseRefName : null,
  };
}

function isGithubPullRequestPayload(value: unknown): value is GithubPullRequestPayload {
  return isRecord(value)
    && typeof value.number === 'number'
    && typeof value.url === 'string'
    && typeof value.state === 'string'
    && typeof value.headRefName === 'string'
    && typeof value.headRefOid === 'string'
    && typeof value.baseRefName === 'string';
}

function parseGithubPullRequest(stdout: string): GithubPullRequestPayload | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return isGithubPullRequestPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readGithubPullRequest(
  cwd: string,
  runCommand: NexusCommandRunner,
): Promise<{ ok: true; pullRequest: GithubPullRequestPayload } | { ok: false; error: string }> {
  const result = await runCommand({
    argv: ['gh', 'pr', 'view', '--json', 'number,url,state,headRefName,headRefOid,baseRefName'],
    cwd,
  });

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || result.stdout.trim() || 'gh pr view failed',
    };
  }

  const payload = parseGithubPullRequest(result.stdout);
  if (!payload) {
    return {
      ok: false,
      error: 'gh pr view returned invalid JSON',
    };
  }

  return { ok: true, pullRequest: payload };
}

async function readCurrentHeadSha(
  cwd: string,
  runCommand: NexusCommandRunner,
): Promise<string | null> {
  const result = await runCommand({
    argv: ['git', 'rev-parse', 'HEAD'],
    cwd,
  });

  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

async function defaultRemote(
  cwd: string,
  runCommand: NexusCommandRunner,
): Promise<string | null> {
  const result = await runCommand({
    argv: ['git', 'remote'],
    cwd,
  });
  if (result.exitCode !== 0) {
    return null;
  }

  const remotes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return remotes.includes('origin') ? 'origin' : remotes[0] ?? null;
}

function remoteFromUpstream(upstream: string): string | null {
  const trimmed = upstream.trim();
  const slash = trimmed.indexOf('/');
  return slash > 0 ? trimmed.slice(0, slash) : null;
}

async function resolvePushHandoff(
  cwd: string,
  headBranch: string,
  headSha: string | null,
  baseBranch: string | null,
  runCommand: NexusCommandRunner,
): Promise<PullRequestRecord | null> {
  const upstreamResult = await runCommand({
    argv: ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    cwd,
  });

  if (upstreamResult.exitCode !== 0) {
    const remote = await defaultRemote(cwd, runCommand);
    if (!remote) {
      return unavailablePullRequest(
        headBranch,
        'Current branch has no upstream and no git remote is configured; cannot push before PR creation.',
        'github',
        headSha,
        baseBranch,
      );
    }
    return pushRequiredPullRequest(
      headBranch,
      headSha,
      baseBranch,
      remote,
      'Current branch has no upstream; push it before creating the PR.',
    );
  }

  const upstream = upstreamResult.stdout.trim();
  const remote = remoteFromUpstream(upstream) ?? (await defaultRemote(cwd, runCommand));
  if (!remote) {
    return unavailablePullRequest(
      headBranch,
      'Unable to determine the git remote for the current branch; cannot push before PR creation.',
      'github',
      headSha,
      baseBranch,
    );
  }

  const aheadResult = await runCommand({
    argv: ['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'],
    cwd,
  });

  if (aheadResult.exitCode !== 0) {
    return unavailablePullRequest(
      headBranch,
      aheadResult.stderr.trim() || aheadResult.stdout.trim() || 'failed to compare local branch with upstream before PR creation',
      'github',
      headSha,
      baseBranch,
    );
  }

  const [, aheadText] = aheadResult.stdout.trim().split(/\s+/);
  const ahead = Number(aheadText ?? '0');
  if (Number.isFinite(ahead) && ahead > 0) {
    return pushRequiredPullRequest(
      headBranch,
      headSha,
      baseBranch,
      remote,
      `Current branch is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of its upstream; push before creating or reusing the PR.`,
    );
  }

  return null;
}

export async function resolveShipPullRequest(
  cwd: string,
  mergeReady: boolean,
  runCommand: NexusCommandRunner = runNexusCommand,
): Promise<PullRequestRecord> {
  if (!mergeReady) {
    return notRequestedPullRequest('Release gate is not merge-ready.');
  }

  const branchResult = await runCommand({
    argv: ['git', 'branch', '--show-current'],
    cwd,
  });

  if (branchResult.exitCode !== 0) {
    return unavailablePullRequest(null, branchResult.stderr.trim() || branchResult.stdout.trim() || 'failed to determine the current branch');
  }

  const headBranch = branchResult.stdout.trim() || null;
  if (!headBranch) {
    return unavailablePullRequest(null, 'Current branch is unknown; cannot prepare PR handoff.');
  }

  const headSha = await readCurrentHeadSha(cwd, runCommand);
  const existingPr = await readGithubPullRequest(cwd, runCommand);
  if (existingPr.ok) {
    const existingState = typeof existingPr.pullRequest.state === 'string'
      ? existingPr.pullRequest.state.toUpperCase()
      : null;
    if (existingState === 'OPEN') {
      if (
        typeof existingPr.pullRequest.headRefOid === 'string'
        && headSha
        && existingPr.pullRequest.headRefOid !== headSha
      ) {
        const remote = await defaultRemote(cwd, runCommand) ?? 'origin';
        return pushRequiredPullRequest(
          headBranch,
          headSha,
          typeof existingPr.pullRequest.baseRefName === 'string' ? existingPr.pullRequest.baseRefName : null,
          remote,
          'Existing PR head SHA does not match local HEAD; push the branch before recording ship as ready.',
        );
      }
      return fromGithubPayload(existingPr.pullRequest, 'reused');
    }
  }

  const baseBranchResult = await runCommand({
    argv: ['gh', 'repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
    cwd,
  });

  if (baseBranchResult.exitCode !== 0) {
    const existingBaseBranch = existingPr.ok && typeof existingPr.pullRequest.baseRefName === 'string'
      ? existingPr.pullRequest.baseRefName
      : null;
    const reason = baseBranchResult.stderr.trim()
      || baseBranchResult.stdout.trim()
      || (!existingPr.ok ? existingPr.error : null)
      || 'gh repo view failed';

    return unavailablePullRequest(
      headBranch,
      reason,
      'github',
      headSha,
      existingBaseBranch,
    );
  }

  const baseBranch = baseBranchResult.stdout.trim() || 'main';
  if (headBranch === baseBranch) {
    return notRequestedPullRequest('Current branch is the base branch; no pull request handoff is required.');
  }

  const pushHandoff = await resolvePushHandoff(cwd, headBranch, headSha, baseBranch, runCommand);
  if (pushHandoff) {
    return pushHandoff;
  }

  const createResult = await runCommand({
    argv: ['gh', 'pr', 'create', '--base', baseBranch, '--head', headBranch, '--fill'],
    cwd,
  });

  if (createResult.exitCode !== 0) {
    return unavailablePullRequest(
      headBranch,
      createResult.stderr.trim() || createResult.stdout.trim() || 'gh pr create failed',
      'github',
      headSha,
      baseBranch,
    );
  }

  const createdPr = await readGithubPullRequest(cwd, runCommand);
  if (!createdPr.ok) {
    return unavailablePullRequest(headBranch, createdPr.error, 'github', headSha, baseBranch);
  }

  return fromGithubPayload(createdPr.pullRequest, 'created');
}
