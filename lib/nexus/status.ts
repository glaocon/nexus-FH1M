import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { StageStatus } from './types';
import { readJsonFile } from './validation-helpers';

function resolveRepoPath(cwd: string, relativePath: string): string {
  return join(cwd, relativePath);
}

// Convention: status reads are passive probes and return null for missing or
// invalid JSON; stage gates that require status should assert separately.
export function readStageStatus(statusPath: string, cwd: string): StageStatus | null {
  return readJsonFile(resolveRepoPath(cwd, statusPath), (value) => value as StageStatus);
}

export function writeStageStatus(statusPath: string, status: StageStatus, cwd: string): void {
  const path = resolveRepoPath(cwd, statusPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(status, null, 2) + '\n');
}
