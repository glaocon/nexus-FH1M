import { readdirSync, rmSync } from 'fs';
import { join } from 'path';

const BUN_BUILD_ARTIFACT_PATTERN = /^\..*\.bun-build$/;

export function cleanupBunBuildArtifacts(root = process.cwd()): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (BUN_BUILD_ARTIFACT_PATTERN.test(entry.name)) {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  cleanupBunBuildArtifacts();
}
