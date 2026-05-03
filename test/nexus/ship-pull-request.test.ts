import { describe, expect, test } from 'bun:test';
import { resolveShipPullRequest } from '../../lib/nexus/ship-pull-request';
import type { NexusCommandRunner, NexusCommandSpec, NexusCommandResult } from '../../lib/nexus/command-runner';

function result(stdout = '', stderr = '', exitCode = 0): NexusCommandResult {
  return { exitCode, stdout, stderr };
}

function githubPullRequest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 123,
    url: 'https://github.com/acme/project/pull/123',
    state: 'OPEN',
    headRefName: 'feature/ship',
    headRefOid: 'local-head-sha',
    baseRefName: 'main',
    ...overrides,
  });
}

function makeRunner(
  handler: (spec: NexusCommandSpec, calls: string[]) => NexusCommandResult | Promise<NexusCommandResult>,
): { runCommand: NexusCommandRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runCommand: async (spec) => {
      calls.push(spec.argv.join(' '));
      return await handler(spec, calls);
    },
  };
}

function makeDefaultRunner(options: {
  branch?: NexusCommandResult;
  headSha?: NexusCommandResult;
  firstPrView?: NexusCommandResult;
  baseBranch?: NexusCommandResult;
  upstream?: NexusCommandResult;
  remotes?: NexusCommandResult;
  ahead?: NexusCommandResult;
  create?: NexusCommandResult;
  secondPrView?: NexusCommandResult;
} = {}): { runCommand: NexusCommandRunner; calls: string[] } {
  let prViewCount = 0;
  return makeRunner((spec) => {
    const command = spec.argv.join(' ');

    if (command === 'git branch --show-current') {
      return options.branch ?? result('feature/ship\n');
    }
    if (command === 'git rev-parse HEAD') {
      return options.headSha ?? result('local-head-sha\n');
    }
    if (command === 'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName') {
      prViewCount += 1;
      if (prViewCount === 1) {
        return options.firstPrView ?? result(githubPullRequest());
      }
      return options.secondPrView ?? result(githubPullRequest({
        number: 456,
        url: 'https://github.com/acme/project/pull/456',
      }));
    }
    if (command === 'gh repo view --json defaultBranchRef -q .defaultBranchRef.name') {
      return options.baseBranch ?? result('main\n');
    }
    if (command === 'git rev-parse --abbrev-ref --symbolic-full-name @{u}') {
      return options.upstream ?? result('origin/feature/ship\n');
    }
    if (command === 'git remote') {
      return options.remotes ?? result('origin\n');
    }
    if (command === 'git rev-list --left-right --count @{u}...HEAD') {
      return options.ahead ?? result('0\t0\n');
    }
    if (command === 'gh pr create --base main --head feature/ship --fill') {
      return options.create ?? result('https://github.com/acme/project/pull/456\n');
    }

    throw new Error(`unexpected command: ${command}`);
  });
}

describe('resolveShipPullRequest', () => {
  test('does not inspect git or GitHub when merge is not ready', async () => {
    const { runCommand, calls } = makeDefaultRunner();

    await expect(resolveShipPullRequest('/repo', false, runCommand)).resolves.toEqual({
      provider: 'github',
      status: 'not_requested',
      number: null,
      url: null,
      state: null,
      head_branch: null,
      head_sha: null,
      base_branch: null,
      reason: 'Release gate is not merge-ready.',
    });
    expect(calls).toEqual([]);
  });

  test('reuses an open pull request when the remote head matches local HEAD', async () => {
    const { runCommand, calls } = makeDefaultRunner();

    await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toEqual({
      provider: 'github',
      status: 'reused',
      number: 123,
      url: 'https://github.com/acme/project/pull/123',
      state: 'OPEN',
      head_branch: 'feature/ship',
      head_sha: 'local-head-sha',
      base_branch: 'main',
    });
    expect(calls).toEqual([
      'git branch --show-current',
      'git rev-parse HEAD',
      'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
    ]);
  });

  test('asks for a push when an open pull request is stale against local HEAD', async () => {
    const { runCommand, calls } = makeDefaultRunner({
      firstPrView: result(githubPullRequest({ headRefOid: 'stale-head-sha' })),
    });

    await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toEqual({
      provider: 'github',
      status: 'push_required',
      number: null,
      url: null,
      state: null,
      head_branch: 'feature/ship',
      head_sha: 'local-head-sha',
      base_branch: 'main',
      reason: 'Existing PR head SHA does not match local HEAD; push the branch before recording ship as ready.',
      push_command: 'git push -u origin HEAD',
    });
    expect(calls).toEqual([
      'git branch --show-current',
      'git rev-parse HEAD',
      'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      'git remote',
    ]);
  });

  test('creates a new pull request when the existing pull request is closed or merged', async () => {
    for (const state of ['CLOSED', 'MERGED'] as const) {
      const { runCommand, calls } = makeDefaultRunner({
        firstPrView: result(githubPullRequest({
          number: 321,
          url: `https://github.com/acme/project/pull/${state.toLowerCase()}`,
          state,
          headRefOid: 'old-head-sha',
        })),
        secondPrView: result(githubPullRequest({
          number: 456,
          url: 'https://github.com/acme/project/pull/456',
        })),
      });

      await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toEqual({
        provider: 'github',
        status: 'created',
        number: 456,
        url: 'https://github.com/acme/project/pull/456',
        state: 'OPEN',
        head_branch: 'feature/ship',
        head_sha: 'local-head-sha',
        base_branch: 'main',
      });
      expect(calls).toEqual([
        'git branch --show-current',
        'git rev-parse HEAD',
        'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
        'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
        'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
        'git rev-list --left-right --count @{u}...HEAD',
        'gh pr create --base main --head feature/ship --fill',
        'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      ]);
    }
  });

  test('returns not requested when the current branch is the base branch', async () => {
    const { runCommand, calls } = makeDefaultRunner({
      branch: result('main\n'),
      firstPrView: result('', 'no PR for branch\n', 1),
    });

    await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toMatchObject({
      provider: 'github',
      status: 'not_requested',
      reason: 'Current branch is the base branch; no pull request handoff is required.',
      head_branch: null,
      base_branch: null,
    });
    expect(calls).toEqual([
      'git branch --show-current',
      'git rev-parse HEAD',
      'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
    ]);
  });

  test('asks for a push when the current branch has no upstream', async () => {
    const { runCommand, calls } = makeDefaultRunner({
      firstPrView: result('', 'no PR for branch\n', 1),
      upstream: result('', 'fatal: no upstream configured\n', 128),
      remotes: result('origin\n'),
    });

    await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toEqual({
      provider: 'github',
      status: 'push_required',
      number: null,
      url: null,
      state: null,
      head_branch: 'feature/ship',
      head_sha: 'local-head-sha',
      base_branch: 'main',
      reason: 'Current branch has no upstream; push it before creating the PR.',
      push_command: 'git push -u origin HEAD',
    });
    expect(calls).toEqual([
      'git branch --show-current',
      'git rev-parse HEAD',
      'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
      'git remote',
    ]);
  });

  test('quotes unusual remotes in the push command for no-upstream branches', async () => {
    const { runCommand } = makeDefaultRunner({
      firstPrView: result('', 'no PR for branch\n', 1),
      upstream: result('', 'fatal: no upstream configured\n', 128),
      remotes: result('fork;rm -rf /\n'),
    });

    await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toMatchObject({
      status: 'push_required',
      push_command: "git push -u 'fork;rm -rf /' HEAD",
    });
  });

  test('asks for a push when the current branch is ahead of upstream', async () => {
    const { runCommand } = makeDefaultRunner({
      firstPrView: result('', 'no PR for branch\n', 1),
      ahead: result('0\t2\n'),
    });

    await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toMatchObject({
      status: 'push_required',
      head_branch: 'feature/ship',
      head_sha: 'local-head-sha',
      base_branch: 'main',
      reason: 'Current branch is 2 commits ahead of its upstream; push before creating or reusing the PR.',
      push_command: 'git push -u origin HEAD',
    });
  });

  test('reports unavailable metadata when branch comparison fails', async () => {
    const { runCommand } = makeDefaultRunner({
      firstPrView: result('', 'no PR for branch\n', 1),
      ahead: result('', 'fatal: ambiguous argument @{u}...HEAD\n', 128),
    });

    await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toEqual({
      provider: 'github',
      status: 'unavailable',
      number: null,
      url: null,
      state: null,
      head_branch: 'feature/ship',
      head_sha: 'local-head-sha',
      base_branch: 'main',
      reason: 'fatal: ambiguous argument @{u}...HEAD',
    });
  });

  test('does not trust malformed GitHub PR payloads before or after create', async () => {
    const { runCommand, calls } = makeDefaultRunner({
      firstPrView: result(JSON.stringify({
        number: '123',
        url: 'https://github.com/acme/project/pull/123',
        state: 'OPEN',
        headRefName: 'feature/ship',
        headRefOid: 'local-head-sha',
        baseRefName: 'main',
      })),
      secondPrView: result(JSON.stringify({})),
    });

    await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toEqual({
      provider: 'github',
      status: 'unavailable',
      number: null,
      url: null,
      state: null,
      head_branch: 'feature/ship',
      head_sha: 'local-head-sha',
      base_branch: 'main',
      reason: 'gh pr view returned invalid JSON',
    });
    expect(calls).toEqual([
      'git branch --show-current',
      'git rev-parse HEAD',
      'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
      'git rev-list --left-right --count @{u}...HEAD',
      'gh pr create --base main --head feature/ship --fill',
      'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
    ]);
  });

  test('reports silent base branch failures after a closed existing PR with stable context', async () => {
    const { runCommand, calls } = makeDefaultRunner({
      firstPrView: result(githubPullRequest({
        number: 321,
        url: 'https://github.com/acme/project/pull/321',
        state: 'CLOSED',
        headRefOid: 'old-head-sha',
        baseRefName: 'release',
      })),
      baseBranch: result('', '', 1),
    });

    await expect(resolveShipPullRequest('/repo', true, runCommand)).resolves.toEqual({
      provider: 'github',
      status: 'unavailable',
      number: null,
      url: null,
      state: null,
      head_branch: 'feature/ship',
      head_sha: 'local-head-sha',
      base_branch: 'release',
      reason: 'gh repo view failed',
    });
    expect(calls).toEqual([
      'git branch --show-current',
      'git rev-parse HEAD',
      'gh pr view --json number,url,state,headRefName,headRefOid,baseRefName',
      'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
    ]);
  });

  test('reports branch discovery and base branch failures with useful context', async () => {
    const branchFailure = makeDefaultRunner({
      branch: result('', 'fatal: not a git repository\n', 128),
    });
    await expect(resolveShipPullRequest('/repo', true, branchFailure.runCommand)).resolves.toMatchObject({
      status: 'unavailable',
      head_branch: null,
      reason: 'fatal: not a git repository',
    });

    const baseFailure = makeDefaultRunner({
      firstPrView: result('', 'no PR for branch\n', 1),
      baseBranch: result('', 'gh: authentication required\n', 1),
    });
    await expect(resolveShipPullRequest('/repo', true, baseFailure.runCommand)).resolves.toMatchObject({
      status: 'unavailable',
      head_branch: 'feature/ship',
      head_sha: 'local-head-sha',
      reason: 'gh: authentication required',
    });
  });
});
