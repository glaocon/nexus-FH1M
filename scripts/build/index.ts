import { spawnSync } from 'child_process';
import { cleanupBunBuildArtifacts } from './cleanup';

type BuildStep = {
  name: string;
  command: string[];
};

const BUILD_STEPS: BuildStep[] = [
  { name: 'gen:skill-docs', command: ['bun', 'run', 'gen:skill-docs', '--host', 'all'] },
  { name: 'build:compile', command: ['bun', 'run', 'build:compile'] },
  { name: 'build:server', command: ['bun', 'run', 'build:server'] },
  { name: 'build:versions', command: ['bun', 'run', 'build:versions'] },
  { name: 'build:chmod', command: ['bun', 'run', 'build:chmod'] },
];

let exitCode = 0;

try {
  for (const step of BUILD_STEPS) {
    const [command, ...args] = step.command;
    const result = spawnSync(command, args, { stdio: 'inherit' });

    if (result.error) {
      console.error(`Build step ${step.name} failed to start: ${result.error.message}`);
      exitCode = 1;
      break;
    }

    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  try {
    cleanupBunBuildArtifacts();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Build cleanup failed: ${message}`);
  }
}

process.exit(exitCode);
