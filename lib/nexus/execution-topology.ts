import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  ExecutionMode,
  PrimaryProvider,
  ProviderTopology,
  RunLedger,
  SessionRootRecord,
  StageStatus,
  WorkspaceRecord,
} from './types';
import { EXECUTION_MODES, PRIMARY_PROVIDERS, PROVIDER_TOPOLOGIES } from './types';
import { isRecord } from './validation-helpers';

export interface ExecutionSelection {
  mode: ExecutionMode;
  primary_provider: PrimaryProvider;
  provider_topology: ProviderTopology;
  requested_execution_path: string;
}

const LOCAL_PROVIDER_BINS: Record<PrimaryProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

const REQUIRED_GOVERNED_PROVIDERS: readonly PrimaryProvider[] = ['codex', 'gemini'] as const;

function readConfigValue(key: string): string | null {
  const stateDir = process.env.NEXUS_STATE_DIR ?? join(homedir(), '.nexus');
  const configPath = join(stateDir, 'config.yaml');
  if (!existsSync(configPath)) {
    return null;
  }

  for (const line of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const trimmedLine = line.trimStart();
    if (!trimmedLine.startsWith(`${key}:`)) {
      continue;
    }

    return parseConfigScalar(trimmedLine.slice(key.length + 1));
  }

  return null;
}

function parseConfigScalar(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    let end = 1;

    while (end < trimmed.length) {
      const char = trimmed[end];
      if (char === quote && trimmed[end - 1] !== '\\') {
        return trimmed.slice(1, end);
      }
      end += 1;
    }

    return trimmed.slice(1);
  }

  const commentIndex = trimmed.search(/\s#/);
  return (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trim();
}

function parseEnumValue<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
): T | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return allowed.includes(normalized as T) ? normalized as T : null;
}

function resolveCommandPath(command: string): string | null {
  const candidates = process.platform === 'win32'
    ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];

  for (const candidate of candidates) {
    try {
      const resolved = Bun.which(candidate);
      if (resolved) {
        return resolved;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function commandExists(command: string): boolean {
  return resolveCommandPath(command) !== null;
}

function mountedCcbProviders(): PrimaryProvider[] {
  const mountedCommand = resolveCommandPath('ccb-mounted');
  if (!mountedCommand) {
    return [];
  }

  const result = Bun.spawnSync([mountedCommand, '--autostart'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout.toString()) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.mounted)) {
      return [];
    }

    return parsed.mounted.filter((provider): provider is PrimaryProvider => (
      typeof provider === 'string'
      && PRIMARY_PROVIDERS.includes(provider as PrimaryProvider)
    ));
  } catch {
    return [];
  }
}

function governedProvidersReady(): boolean {
  if (!commandExists('ask')) {
    return false;
  }

  const mounted = mountedCcbProviders();
  return REQUIRED_GOVERNED_PROVIDERS.every((provider) => mounted.includes(provider));
}

function defaultLocalProvider(): PrimaryProvider {
  return (['claude', 'codex', 'gemini'] as const).find((provider) => commandExists(LOCAL_PROVIDER_BINS[provider]))
    ?? 'claude';
}

export function localExecutionPath(
  provider: PrimaryProvider,
  topology: ProviderTopology,
  scope: 'build' | 'audit_a' | 'audit_b' | 'qa' = 'build',
): string {
  const suffix = scope === 'build' ? '' : `-${scope.replace('_', '-')}`;
  return `${provider}-local-${topology}${suffix}`;
}

export function defaultExecutionSelection(): ExecutionSelection {
  const configuredMode = parseEnumValue(process.env.NEXUS_EXECUTION_MODE, EXECUTION_MODES)
    ?? parseEnumValue(readConfigValue('execution_mode'), EXECUTION_MODES);
  const configuredProvider = parseEnumValue(process.env.NEXUS_PRIMARY_PROVIDER, PRIMARY_PROVIDERS)
    ?? parseEnumValue(readConfigValue('primary_provider'), PRIMARY_PROVIDERS);
  const configuredTopology = parseEnumValue(process.env.NEXUS_PROVIDER_TOPOLOGY, PROVIDER_TOPOLOGIES)
    ?? parseEnumValue(readConfigValue('provider_topology'), PROVIDER_TOPOLOGIES);
  const ccbReady = governedProvidersReady();

  const mode: ExecutionMode = configuredMode
    ?? (ccbReady ? 'governed_ccb' : 'local_provider');

  if (mode === 'governed_ccb') {
    return {
      mode,
      primary_provider: 'codex',
      provider_topology: 'multi_session',
      requested_execution_path: 'codex-via-ccb',
    };
  }

  const primaryProvider = configuredProvider
    ?? defaultLocalProvider();
  const topology = configuredTopology ?? 'single_agent';

  return {
    mode,
    primary_provider: primaryProvider,
    provider_topology: topology,
    requested_execution_path: localExecutionPath(primaryProvider, topology),
  };
}

export function executionFieldsFromLedger(
  ledger: RunLedger,
  actualPath: string | null = ledger.execution.actual_path,
): Pick<
  StageStatus,
  'execution_mode' | 'primary_provider' | 'provider_topology' | 'workspace' | 'session_root' | 'requested_execution_path' | 'actual_execution_path'
> {
  return {
    execution_mode: ledger.execution.mode,
    primary_provider: ledger.execution.primary_provider,
    provider_topology: ledger.execution.provider_topology,
    workspace: ledger.execution.workspace,
    session_root: ledger.execution.session_root,
    requested_execution_path: ledger.execution.requested_path,
    actual_execution_path: actualPath,
  };
}

export function withActualExecutionPath(ledger: RunLedger, actualPath: string | null): RunLedger {
  return {
    ...ledger,
    execution: {
      ...ledger.execution,
      actual_path: actualPath,
    },
  };
}

export function withExecutionWorkspace(ledger: RunLedger, workspace: WorkspaceRecord): RunLedger {
  return {
    ...ledger,
    execution: {
      ...ledger.execution,
      workspace,
    },
  };
}

export function withExecutionSessionRoot(ledger: RunLedger, sessionRoot: SessionRootRecord): RunLedger {
  return {
    ...ledger,
    execution: {
      ...ledger.execution,
      session_root: sessionRoot,
    },
  };
}
