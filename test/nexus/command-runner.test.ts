import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { runNexusCommand } from '../../lib/nexus/command-runner';

describe('nexus command runner', () => {
  test('passes cwd and merged env to the spawned command', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-command-runner-'));
    mkdirSync(join(cwd, 'nested'), { recursive: true });
    const nested = join(cwd, 'nested');

    try {
      const result = await runNexusCommand({
        argv: [
          process.execPath,
          '-e',
          "console.log(process.cwd()); console.error(process.env.NEXUS_COMMAND_RUNNER_TEST);",
        ],
        cwd: nested,
        env: { NEXUS_COMMAND_RUNNER_TEST: 'merged-env' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(nested);
      expect(result.stderr.trim()).toBe('merged-env');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('returns nonzero exit status and stderr without throwing', async () => {
    const result = await runNexusCommand({
      argv: [
        process.execPath,
        '-e',
        "process.stderr.write('boom'); process.exit(7);",
      ],
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('boom');
  });
});
