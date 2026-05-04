import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { describe, expect, test } from 'bun:test';
import { defaultExecutionSelection } from '../../lib/nexus/execution-topology';

function withExecutionState(
  config: string,
  env: Record<string, string | undefined>,
  fn: () => void,
): void {
  const stateDir = mkdtempSync(join(tmpdir(), 'nexus-execution-topology-'));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.yaml'), config);

  const keys = [
    'NEXUS_STATE_DIR',
    'NEXUS_EXECUTION_MODE',
    'NEXUS_PRIMARY_PROVIDER',
    'NEXUS_PROVIDER_TOPOLOGY',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]] as const));

  process.env.NEXUS_STATE_DIR = stateDir;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    rmSync(stateDir, { recursive: true, force: true });
  }
}

function runSelectionWithPath(binSetup: (binDir: string) => void): unknown {
  const stateDir = mkdtempSync(join(tmpdir(), 'nexus-execution-topology-'));
  const binDir = join(stateDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.yaml'), '');
  binSetup(binDir);
  const pathValue = `${binDir}${delimiter}${process.env.PATH ?? '/bin:/usr/bin'}`;

  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      'import { defaultExecutionSelection } from "./lib/nexus/execution-topology"; console.log(JSON.stringify(defaultExecutionSelection()));',
    ],
    {
      cwd: join(import.meta.dir, '..', '..'),
      env: {
        ...process.env,
        NEXUS_STATE_DIR: stateDir,
        PATH: pathValue,
        ...(process.platform === 'win32' ? { Path: pathValue } : {}),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  try {
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function writeStubCommand(binDir: string, name: string, body: string): void {
  const commandPath = join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(
    commandPath,
    process.platform === 'win32'
      ? `@echo off\r\n${body}\r\n`
      : `#!/usr/bin/env bash\n${body}\n`,
  );
  if (process.platform !== 'win32') {
    chmodSync(commandPath, 0o755);
  }
}

describe('execution topology selection', () => {
  test('parses quoted config scalars and inline comments', () => {
    withExecutionState(
      [
        'execution_mode: "local_provider"',
        'primary_provider: "codex"',
        'provider_topology: subagents # note',
      ].join('\n'),
      {
        NEXUS_EXECUTION_MODE: 'not-a-mode',
        NEXUS_PRIMARY_PROVIDER: 'not-a-provider',
        NEXUS_PROVIDER_TOPOLOGY: 'not-a-topology',
      },
      () => {
        expect(defaultExecutionSelection()).toEqual({
          mode: 'local_provider',
          primary_provider: 'codex',
          provider_topology: 'subagents',
          requested_execution_path: 'codex-local-subagents',
        });
      },
    );
  });

  test('ignores invalid enum values from config', () => {
    withExecutionState(
      [
        'execution_mode: bogus',
        'primary_provider: "wrong" # note',
        'provider_topology: invalid',
      ].join('\n'),
      {
        NEXUS_EXECUTION_MODE: 'local_provider',
        NEXUS_PRIMARY_PROVIDER: 'codex',
        NEXUS_PROVIDER_TOPOLOGY: 'subagents',
      },
      () => {
        expect(defaultExecutionSelection()).toEqual({
          mode: 'local_provider',
          primary_provider: 'codex',
          provider_topology: 'subagents',
          requested_execution_path: 'codex-local-subagents',
        });
      },
    );
  });

  test('accepts claude local agent_team topology from config', () => {
    withExecutionState(
      [
        'execution_mode: local_provider',
        'primary_provider: claude',
        'provider_topology: agent_team',
      ].join('\n'),
      {
        NEXUS_EXECUTION_MODE: undefined,
        NEXUS_PRIMARY_PROVIDER: undefined,
        NEXUS_PROVIDER_TOPOLOGY: undefined,
      },
      () => {
        expect(defaultExecutionSelection()).toEqual({
          mode: 'local_provider',
          primary_provider: 'claude',
          provider_topology: 'agent_team',
          requested_execution_path: 'claude-local-agent_team',
        });
      },
    );
  });

  test('uses governed_ccb as the machine default only when required providers are mounted', () => {
    const selection = runSelectionWithPath((binDir) => {
      writeStubCommand(binDir, 'ask', process.platform === 'win32' ? 'exit /b 0' : 'exit 0');
      writeStubCommand(
        binDir,
        'ccb-mounted',
        process.platform === 'win32'
          ? 'echo {"cwd":"/tmp/test","mounted":["codex","gemini","claude"]}'
          : 'printf \'{"cwd":"/tmp/test","mounted":["codex","gemini","claude"]}\\n\'',
      );
    });

    expect(selection).toEqual({
      mode: 'governed_ccb',
      primary_provider: 'codex',
      provider_topology: 'multi_session',
      requested_execution_path: 'codex-via-ccb',
    });
  });

  test('falls back to local_provider when CCB exists but governed providers are incomplete', () => {
    const selection = runSelectionWithPath((binDir) => {
      writeStubCommand(binDir, 'ask', process.platform === 'win32' ? 'exit /b 0' : 'exit 0');
      writeStubCommand(binDir, 'claude', process.platform === 'win32' ? 'exit /b 0' : 'exit 0');
      writeStubCommand(
        binDir,
        'ccb-mounted',
        process.platform === 'win32'
          ? 'echo {"cwd":"/tmp/test","mounted":["codex"]}'
          : 'printf \'{"cwd":"/tmp/test","mounted":["codex"]}\\n\'',
      );
    });

    expect(selection).toEqual({
      mode: 'local_provider',
      primary_provider: 'claude',
      provider_topology: 'single_agent',
      requested_execution_path: 'claude-local-single_agent',
    });
  });

  test('falls back to local_provider when ccb-mounted JSON has the wrong shape', () => {
    const selection = runSelectionWithPath((binDir) => {
      writeStubCommand(binDir, 'ask', process.platform === 'win32' ? 'exit /b 0' : 'exit 0');
      writeStubCommand(binDir, 'claude', process.platform === 'win32' ? 'exit /b 0' : 'exit 0');
      writeStubCommand(
        binDir,
        'ccb-mounted',
        process.platform === 'win32'
          ? 'echo {"cwd":"/tmp/test","mounted":"codex"}'
          : 'printf \'{"cwd":"/tmp/test","mounted":"codex"}\\n\'',
      );
    });

    expect(selection).toEqual({
      mode: 'local_provider',
      primary_provider: 'claude',
      provider_topology: 'single_agent',
      requested_execution_path: 'claude-local-single_agent',
    });
  });
});
