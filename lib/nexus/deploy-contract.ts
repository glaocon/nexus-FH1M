import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { deployContractJsonPath } from './artifacts';
import { isRecord, readJsonPartial } from './validation-helpers';
import {
  DEPLOY_CONFIG_SOURCES,
  DEPLOY_PLATFORMS,
  DEPLOY_PROJECT_TYPES,
  DEPLOY_STATUS_KINDS,
  DEPLOY_TRIGGER_KINDS,
  type DeployConfigSource,
  type DeployContractRecord,
  type DeployPlatform,
  type DeployProjectType,
  type DeployReadinessRecord,
  type DeployStatusKind,
  type DeployTriggerKind,
} from './types';

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function oneOf<T extends readonly string[]>(value: unknown, options: T, fallback: T[number]): T[number] {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }

  return (options as readonly string[]).includes(value) ? value as T[number] : fallback;
}

function normalizePlatform(value: unknown): DeployPlatform {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return 'unknown';
  }

  if (normalized.includes('fly')) return 'fly';
  if (normalized.includes('render')) return 'render';
  if (normalized.includes('vercel')) return 'vercel';
  if (normalized.includes('netlify')) return 'netlify';
  if (normalized.includes('heroku')) return 'heroku';
  if (normalized.includes('railway')) return 'railway';
  if (normalized.includes('github')) return 'github_actions';
  if (normalized === 'none' || normalized.includes("doesn't deploy") || normalized.includes('does not deploy')) return 'none';
  if (normalized.includes('custom')) return 'custom';

  return oneOf(normalized, DEPLOY_PLATFORMS, 'unknown');
}

function normalizeProjectType(value: unknown): DeployProjectType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return 'unknown';
  }

  if (normalized.includes('web')) return 'web_app';
  if (normalized.includes('api')) return 'api';
  if (normalized.includes('cli')) return 'cli';
  if (normalized.includes('library')) return 'library';
  if (normalized.includes('service')) return 'service';

  return oneOf(normalized, DEPLOY_PROJECT_TYPES, 'unknown');
}

function normalizeTrigger(value: unknown): DeployTriggerKind {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return 'none';
  }

  if (normalized.includes('automatic on push') || normalized.includes('auto-deploy on push') || normalized.includes('auto deploy on push')) {
    return 'auto_on_push';
  }
  if (normalized.includes('github actions')) return 'github_actions';
  if (normalized.includes('manual')) return 'manual';
  if (normalized.includes('command') || normalized.includes('script') || normalized.includes('cli')) return 'command';
  if (normalized === 'none') return 'none';

  return oneOf(normalized, DEPLOY_TRIGGER_KINDS, 'command');
}

function normalizeStatusKind(command: unknown, workflow: unknown): DeployStatusKind {
  const normalizedCommand = typeof command === 'string' ? command.trim() : '';
  const normalizedWorkflow = typeof workflow === 'string' ? workflow.trim() : '';
  if (!normalizedCommand || normalizedCommand.toLowerCase() === 'none') {
    return normalizedWorkflow ? 'github_actions' : 'none';
  }
  if (normalizedCommand.toLowerCase().includes('http health check')) {
    return 'http';
  }

  return 'command';
}

function parseBulletValue(section: string, label: string): string | null {
  const pattern = new RegExp(`^-\\s+${label}:\\s*(.+)$`, 'im');
  const match = section.match(pattern);
  const value = match?.[1]?.trim() ?? '';
  return value.length > 0 ? value : null;
}

function parseHookValue(section: string, label: string): string | null {
  const pattern = new RegExp(`^-\\s+${label}:\\s*(.+)$`, 'im');
  const match = section.match(pattern);
  const value = match?.[1]?.trim() ?? '';
  return value.length > 0 ? value : null;
}

function sanitizeCommand(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === 'none' || normalized.toLowerCase() === 'http health check') {
    return null;
  }

  return normalized;
}

function splitHooks(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  if (value.trim().toLowerCase() === 'none') {
    return [];
  }

  return value
    .split(/\s*;\s*/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readSection(content: string, header: string): string | null {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === header.trim());
  if (startIndex === -1) {
    return null;
  }

  const collected: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ') && i > startIndex + 1) {
      break;
    }
    collected.push(line);
  }

  return collected.join('\n').trim();
}

function normalizeSurfaceLabel(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeSecondarySurfaces(contract: Record<string, unknown>): DeployContractRecord['secondary_surfaces'] {
  if (!Array.isArray(contract.secondary_surfaces)) {
    return [];
  }

  return contract.secondary_surfaces
    .map((surface, index) => {
      const entry = recordOrNull(surface);
      if (!entry) {
        return null;
      }

      const production = recordOrNull(entry.production);
      const deployTrigger = recordOrNull(entry.deploy_trigger);
      const deployStatus = recordOrNull(entry.deploy_status);
      const label = normalizeSurfaceLabel(entry.label) ?? `secondary-${index + 1}`;

      return {
        label,
        platform: normalizePlatform(entry.platform),
        project_type: normalizeProjectType(entry.project_type),
        production: {
          url: stringOrNull(production?.url),
          health_check: stringOrNull(production?.health_check),
        },
        deploy_trigger: {
          kind: oneOf(deployTrigger?.kind, DEPLOY_TRIGGER_KINDS, 'none'),
          details: stringOrNull(deployTrigger?.details),
        },
        deploy_workflow: stringOrNull(entry.deploy_workflow),
        deploy_status: {
          kind: oneOf(deployStatus?.kind, DEPLOY_STATUS_KINDS, 'none'),
          command: stringOrNull(deployStatus?.command),
        },
        notes: stringArray(entry.notes),
        sources: stringArray(entry.sources),
      };
    })
    .filter((surface): surface is DeployContractRecord['secondary_surfaces'][number] => surface !== null);
}

export function readCanonicalDeployContract(cwd: string): DeployContractRecord | null {
  // Note: previously bare `JSON.parse(readFileSync(...))` — would crash on
  // malformed JSON. `readJsonPartial` collapses missing-file and parse-error
  // into the same null path, matching the existing "no canonical contract"
  // semantic and removing the latent crash.
  const parsed = readJsonPartial<DeployContractRecord>(join(cwd, deployContractJsonPath()));
  if (!isRecord(parsed)) {
    return null;
  }

  const production = recordOrNull(parsed.production);
  const staging = recordOrNull(parsed.staging);
  const deployTrigger = recordOrNull(parsed.deploy_trigger);
  const deployStatus = recordOrNull(parsed.deploy_status);
  const customHooks = recordOrNull(parsed.custom_hooks);

  return {
    schema_version: 1,
    configured_at: typeof parsed.configured_at === 'string' ? parsed.configured_at : new Date().toISOString(),
    primary_surface_label: normalizeSurfaceLabel(parsed.primary_surface_label),
    platform: normalizePlatform(parsed.platform),
    project_type: normalizeProjectType(parsed.project_type),
    production: {
      url: stringOrNull(production?.url),
      health_check: stringOrNull(production?.health_check),
    },
    staging: {
      url: stringOrNull(staging?.url),
      workflow: stringOrNull(staging?.workflow),
    },
    deploy_trigger: {
      kind: oneOf(deployTrigger?.kind, DEPLOY_TRIGGER_KINDS, 'none'),
      details: stringOrNull(deployTrigger?.details),
    },
    deploy_workflow: stringOrNull(parsed.deploy_workflow),
    deploy_status: {
      kind: oneOf(deployStatus?.kind, DEPLOY_STATUS_KINDS, 'none'),
      command: stringOrNull(deployStatus?.command),
    },
    custom_hooks: {
      pre_merge: stringArray(customHooks?.pre_merge),
      post_merge: stringArray(customHooks?.post_merge),
    },
    secondary_surfaces: normalizeSecondarySurfaces(parsed),
    notes: stringArray(parsed.notes),
    sources: stringArray(parsed.sources),
  };
}

export function readLegacyClaudeDeployContract(cwd: string): DeployContractRecord | null {
  const path = join(cwd, 'CLAUDE.md');
  if (!existsSync(path)) {
    return null;
  }

  const content = readFileSync(path, 'utf8');
  const configSection = readSection(content, '## Deploy Configuration (configured by /setup-deploy)')
    ?? readSection(content, '## Deploy Configuration');
  if (!configSection) {
    return null;
  }

  const hooksSection = readSection(content, '### Custom deploy hooks');
  const platform = normalizePlatform(parseBulletValue(configSection, 'Platform'));
  const projectType = normalizeProjectType(parseBulletValue(configSection, 'Project type'));
  const productionUrl = parseBulletValue(configSection, 'Production URL');
  const deployWorkflow = parseBulletValue(configSection, 'Deploy workflow');
  const deployStatusCommand = sanitizeCommand(parseBulletValue(configSection, 'Deploy status command') ?? parseHookValue(hooksSection ?? '', 'Deploy status'));
  const healthCheck = parseBulletValue(configSection, 'Post-deploy health check') ?? parseHookValue(hooksSection ?? '', 'Health check');
  const deployTriggerDetails = parseHookValue(hooksSection ?? '', 'Deploy trigger') ?? deployWorkflow;
  const triggerKind = normalizeTrigger(deployTriggerDetails);
  const statusKind = normalizeStatusKind(deployStatusCommand, deployWorkflow);

  return {
    schema_version: 1,
    configured_at: '',
    primary_surface_label: projectType === 'web_app' ? 'web' : null,
    platform,
    project_type: projectType,
    production: {
      url: productionUrl,
      health_check: healthCheck,
    },
    staging: {
      url: parseBulletValue(configSection, 'Staging URL'),
      workflow: parseBulletValue(configSection, 'Staging workflow'),
    },
    deploy_trigger: {
      kind: triggerKind,
      details: deployTriggerDetails ?? null,
    },
    deploy_workflow: deployWorkflow,
    deploy_status: {
      kind: statusKind,
      command: deployStatusCommand,
    },
    custom_hooks: {
      pre_merge: splitHooks(parseHookValue(hooksSection ?? '', 'Pre-merge')),
      post_merge: splitHooks(parseHookValue(hooksSection ?? '', 'Post-merge')),
    },
    secondary_surfaces: [],
    notes: ['Recovered from legacy CLAUDE.md deploy configuration.'],
    sources: ['CLAUDE.md'],
  };
}

function readinessFromContract(
  source: Exclude<DeployConfigSource, 'none'>,
  contract: DeployContractRecord,
  runId: string,
  generatedAt: string,
  contractPath: string | null,
): DeployReadinessRecord {
  const secondarySurfaces = contract.secondary_surfaces.map((surface) => ({
    label: surface.label,
    platform: surface.platform,
    project_type: surface.project_type,
    production_url: surface.production.url,
    health_check: surface.production.health_check,
    deploy_status_kind: surface.deploy_status.kind,
    deploy_status_command: surface.deploy_status.command,
    deploy_workflow: surface.deploy_workflow,
    blocking: false as const,
    notes: surface.notes,
  }));

  return {
    schema_version: 1,
    run_id: runId,
    generated_at: generatedAt,
    configured: contract.platform !== 'unknown',
    source,
    contract_path: contractPath,
    primary_surface_label: contract.primary_surface_label,
    platform: contract.platform,
    project_type: contract.project_type,
    production_url: contract.production.url,
    health_check: contract.production.health_check,
    deploy_status_kind: contract.deploy_status.kind,
    deploy_status_command: contract.deploy_status.command,
    deploy_workflow: contract.deploy_workflow,
    staging_detected: Boolean(contract.staging.url || contract.staging.workflow),
    secondary_surfaces: secondarySurfaces,
    notes: secondarySurfaces.length > 0
      ? [
          ...contract.notes,
          `Secondary deploy surfaces detected: ${secondarySurfaces.map((surface) => `${surface.label} (${surface.platform})`).join(', ')}`,
        ]
      : contract.notes,
  };
}

export function resolveDeployReadiness(cwd: string, runId: string, generatedAt: string): DeployReadinessRecord {
  const canonical = readCanonicalDeployContract(cwd);
  if (canonical) {
    return readinessFromContract('canonical_contract', canonical, runId, generatedAt, deployContractJsonPath());
  }

  const legacy = readLegacyClaudeDeployContract(cwd);
  if (legacy) {
    return readinessFromContract('legacy_claude', legacy, runId, generatedAt, null);
  }

  return {
    schema_version: 1,
    run_id: runId,
    generated_at: generatedAt,
    configured: false,
    source: 'none',
    contract_path: null,
    primary_surface_label: null,
    platform: null,
    project_type: null,
    production_url: null,
    health_check: null,
    deploy_status_kind: 'none',
    deploy_status_command: null,
    deploy_workflow: null,
    staging_detected: false,
    secondary_surfaces: [],
    notes: [],
  };
}
