import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, parse } from 'path';
import { getDefaultNexusAdapters } from '../../../lib/nexus/adapters/registry';
import type { NexusAdapters } from '../../../lib/nexus/adapters/types';
import { resolveInvocation } from '../../../lib/nexus/commands/index';
import type { CommandResult } from '../../../lib/nexus/commands/index';
import type { ExecutionSelection } from '../../../lib/nexus/execution-topology';
import type { ReviewAdvisoryDisposition } from '../../../lib/nexus/types';
import { resolveRepositoryRoot } from '../../../lib/nexus/workspace-substrate';

function normalizePathForComparison(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isolatedTempRootCandidate(root: string | undefined): string | null {
  if (!root) {
    return null;
  }

  try {
    mkdirSync(root, { recursive: true });
    const probe = mkdtempSync(join(root, 'nexus-probe-'));
    try {
      return normalizePathForComparison(resolveRepositoryRoot(probe)) === normalizePathForComparison(probe)
        ? root
        : null;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}

function resolveIsolatedTempRoot(): string {
  const root = parse(tmpdir()).root;
  const candidates = [
    tmpdir(),
    process.env.RUNNER_TEMP,
    process.env.TEST_TMPDIR,
    process.platform === 'win32' ? join(root, 'Windows', 'Temp') : join(root, 'tmp'),
  ];

  return candidates.map(isolatedTempRootCandidate).find((candidate): candidate is string => candidate !== null)
    ?? tmpdir();
}

const TEMP_ROOT = resolveIsolatedTempRoot();
const existingGitCeilingDirectories = process.env.GIT_CEILING_DIRECTORIES
  ?.split(delimiter)
  .filter(Boolean) ?? [];
if (!existingGitCeilingDirectories.includes(TEMP_ROOT)) {
  process.env.GIT_CEILING_DIRECTORIES = [TEMP_ROOT, ...existingGitCeilingDirectories].join(delimiter);
}

interface TempRepoInvocationOptions {
  reviewAdvisoryDispositionOverride?: ReviewAdvisoryDisposition | null;
}

interface TempRepoRun {
  (
    command: string,
    adapters?: NexusAdapters,
    execution?: ExecutionSelection,
    options?: TempRepoInvocationOptions,
  ): Promise<CommandResult>;
  readJson: (path: string) => Promise<any>;
  readFile: (path: string) => Promise<string>;
  exists: (path: string) => boolean;
}

export async function runInTempRepo(
  fn: (ctx: { cwd: string; run: TempRepoRun }) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(TEMP_ROOT, 'nexus-plan-'));
  mkdirSync(join(cwd, '.planning'), { recursive: true });

  const run = Object.assign(
    async (
      command: string,
      adapters = getDefaultNexusAdapters(),
      execution: ExecutionSelection = {
        mode: 'governed_ccb',
        primary_provider: 'codex',
        provider_topology: 'multi_session',
        requested_execution_path: 'codex-via-ccb',
      },
      options: TempRepoInvocationOptions = {},
    ) => {
      const invocation = resolveInvocation(command);
      return await invocation.handler({
        cwd,
        clock: () => new Date().toISOString(),
        via: invocation.via,
        adapters,
        execution,
        review_advisory_disposition_override: options.reviewAdvisoryDispositionOverride ?? null,
      });
    },
    {
      readJson: async (path: string) => JSON.parse(readFileSync(join(cwd, path), 'utf8')),
      readFile: async (path: string) => readFileSync(join(cwd, path), 'utf8'),
      exists: (path: string) => existsSync(join(cwd, path)),
    },
  ) as TempRepoRun;

  try {
    await fn({ cwd, run });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
