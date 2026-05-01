import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { deployContractJsonPath } from '../../lib/nexus/artifacts';
import {
  readCanonicalDeployContract,
  readLegacyClaudeDeployContract,
  resolveDeployReadiness,
} from '../../lib/nexus/deploy-contract';

const tempRepos: string[] = [];

function makeTempRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'nexus-deploy-contract-'));
  tempRepos.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempRepos.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function writeRepoFile(cwd: string, path: string, content: string): void {
  const absolutePath = join(cwd, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function writeRepoJson(cwd: string, path: string, value: unknown): void {
  writeRepoFile(cwd, path, JSON.stringify(value, null, 2) + '\n');
}

describe('readCanonicalDeployContract', () => {
  test('normalizes canonical deploy contracts and filters unsupported payload entries', () => {
    const cwd = makeTempRepo();
    writeRepoJson(cwd, deployContractJsonPath(), {
      schema_version: 1,
      configured_at: '2026-01-01T00:00:00.000Z',
      primary_surface_label: '  Web UI  ',
      platform: 'Fly.io',
      project_type: 'web application',
      production: {
        url: 'https://app.example.com',
        health_check: 'https://app.example.com/health',
      },
      staging: {
        url: 'https://staging.example.com',
        workflow: '.github/workflows/staging.yml',
      },
      deploy_trigger: {
        kind: 'auto_on_push',
        details: 'main branch push',
      },
      deploy_workflow: '.github/workflows/deploy.yml',
      deploy_status: {
        kind: 'command',
        command: 'fly status --app app',
      },
      custom_hooks: {
        pre_merge: ['bun test', 42, 'bun run build'],
        post_merge: ['bun run canary', null],
      },
      secondary_surfaces: [
        {
          label: '',
          platform: 'GitHub Actions',
          project_type: 'worker service',
          production: {
            url: 'https://worker.example.com',
            health_check: null,
          },
          deploy_trigger: {
            kind: 'github_actions',
            details: '.github/workflows/worker.yml',
          },
          deploy_workflow: '.github/workflows/worker.yml',
          deploy_status: {
            kind: 'github_actions',
            command: null,
          },
          notes: ['optional worker', 123],
          sources: ['.github/workflows/worker.yml', false],
        },
        null,
        'invalid secondary surface',
      ],
      notes: ['primary deploy', 123],
      sources: ['fly.toml', false, '.github/workflows/deploy.yml'],
    });

    expect(readCanonicalDeployContract(cwd)).toEqual({
      schema_version: 1,
      configured_at: '2026-01-01T00:00:00.000Z',
      primary_surface_label: 'Web UI',
      platform: 'fly',
      project_type: 'web_app',
      production: {
        url: 'https://app.example.com',
        health_check: 'https://app.example.com/health',
      },
      staging: {
        url: 'https://staging.example.com',
        workflow: '.github/workflows/staging.yml',
      },
      deploy_trigger: {
        kind: 'auto_on_push',
        details: 'main branch push',
      },
      deploy_workflow: '.github/workflows/deploy.yml',
      deploy_status: {
        kind: 'command',
        command: 'fly status --app app',
      },
      custom_hooks: {
        pre_merge: ['bun test', 'bun run build'],
        post_merge: ['bun run canary'],
      },
      secondary_surfaces: [
        {
          label: 'secondary-1',
          platform: 'github_actions',
          project_type: 'service',
          production: {
            url: 'https://worker.example.com',
            health_check: null,
          },
          deploy_trigger: {
            kind: 'github_actions',
            details: '.github/workflows/worker.yml',
          },
          deploy_workflow: '.github/workflows/worker.yml',
          deploy_status: {
            kind: 'github_actions',
            command: null,
          },
          notes: ['optional worker'],
          sources: ['.github/workflows/worker.yml'],
        },
      ],
      notes: ['primary deploy'],
      sources: ['fly.toml', '.github/workflows/deploy.yml'],
    });
  });

  test('returns null for missing, malformed, and non-object canonical payloads', () => {
    const cwd = makeTempRepo();

    expect(readCanonicalDeployContract(cwd)).toBeNull();

    writeRepoFile(cwd, deployContractJsonPath(), '{not valid json');
    expect(readCanonicalDeployContract(cwd)).toBeNull();

    writeRepoJson(cwd, deployContractJsonPath(), ['not', 'an', 'object']);
    expect(readCanonicalDeployContract(cwd)).toBeNull();
  });

  test('coerces adversarial canonical object fields into safe defaults', () => {
    const cwd = makeTempRepo();
    writeRepoJson(cwd, deployContractJsonPath(), {
      configured_at: 42,
      primary_surface_label: 123,
      platform: 123,
      project_type: false,
      production: 'invalid',
      staging: null,
      deploy_trigger: {
        kind: 'invented',
        details: 7,
      },
      deploy_workflow: true,
      deploy_status: {
        kind: 'invented',
        command: 42,
      },
      custom_hooks: {
        pre_merge: 'bun test',
        post_merge: ['bun run canary', 1],
      },
      secondary_surfaces: [
        {
          label: 99,
          platform: 'unknown platform',
          project_type: 'library',
          production: 42,
          deploy_trigger: 'invalid',
          deploy_status: 'invalid',
          notes: 'invalid',
          sources: ['worker.yml'],
        },
      ],
      notes: 'invalid',
      sources: ['deploy-contract.json', 1],
    });

    const contract = readCanonicalDeployContract(cwd);
    expect(contract).toMatchObject({
      schema_version: 1,
      primary_surface_label: null,
      platform: 'unknown',
      project_type: 'unknown',
      production: {
        url: null,
        health_check: null,
      },
      staging: {
        url: null,
        workflow: null,
      },
      deploy_trigger: {
        kind: 'none',
        details: null,
      },
      deploy_workflow: null,
      deploy_status: {
        kind: 'none',
        command: null,
      },
      custom_hooks: {
        pre_merge: [],
        post_merge: ['bun run canary'],
      },
      secondary_surfaces: [
        expect.objectContaining({
          label: 'secondary-1',
          platform: 'unknown',
          project_type: 'library',
          production: {
            url: null,
            health_check: null,
          },
          deploy_trigger: {
            kind: 'none',
            details: null,
          },
          deploy_status: {
            kind: 'none',
            command: null,
          },
          notes: [],
          sources: ['worker.yml'],
        }),
      ],
      notes: [],
      sources: ['deploy-contract.json'],
    });
    expect(contract?.configured_at).toEqual(expect.any(String));
  });
});

describe('readLegacyClaudeDeployContract', () => {
  test('recovers deploy settings from legacy CLAUDE.md setup sections', () => {
    const cwd = makeTempRepo();
    writeRepoFile(cwd, 'CLAUDE.md', [
      '# Project Instructions',
      '',
      '## Deploy Configuration (configured by /setup-deploy)',
      '- Platform: Vercel',
      '- Production URL: https://app.example.com',
      '- Staging URL: https://staging.example.com',
      '- Staging workflow: .github/workflows/staging.yml',
      '- Deploy workflow: GitHub Actions deploy workflow',
      '- Deploy status command: npm run deploy:status',
      '- Merge method: squash',
      '- Project type: web app',
      '- Post-deploy health check: https://app.example.com/health',
      '',
      '### Custom deploy hooks',
      '- Pre-merge: bun test ; bun run build',
      '- Deploy trigger: automatic on push to main',
      '- Deploy status: npm run deploy:status',
      '- Health check: https://app.example.com/health',
      '- Post-merge: bun run smoke ; bun run canary',
    ].join('\n'));

    expect(readLegacyClaudeDeployContract(cwd)).toMatchObject({
      schema_version: 1,
      configured_at: '',
      primary_surface_label: 'web',
      platform: 'vercel',
      project_type: 'web_app',
      production: {
        url: 'https://app.example.com',
        health_check: 'https://app.example.com/health',
      },
      staging: {
        url: 'https://staging.example.com',
        workflow: '.github/workflows/staging.yml',
      },
      deploy_trigger: {
        kind: 'auto_on_push',
        details: 'automatic on push to main',
      },
      deploy_workflow: 'GitHub Actions deploy workflow',
      deploy_status: {
        kind: 'command',
        command: 'npm run deploy:status',
      },
      custom_hooks: {
        pre_merge: ['bun test', 'bun run build'],
        post_merge: ['bun run smoke', 'bun run canary'],
      },
      notes: ['Recovered from legacy CLAUDE.md deploy configuration.'],
      sources: ['CLAUDE.md'],
    });
  });

  test('returns null when legacy deploy sections are absent', () => {
    const cwd = makeTempRepo();
    writeRepoFile(cwd, 'CLAUDE.md', '# Project Instructions\n\nNo deploy notes here.\n');

    expect(readLegacyClaudeDeployContract(cwd)).toBeNull();
  });
});

describe('resolveDeployReadiness', () => {
  test('prefers canonical contract over legacy CLAUDE.md and summarizes secondary surfaces', () => {
    const cwd = makeTempRepo();
    writeRepoJson(cwd, deployContractJsonPath(), {
      platform: 'Railway',
      project_type: 'service',
      primary_surface_label: 'api',
      production: {
        url: 'https://api.example.com',
        health_check: 'https://api.example.com/health',
      },
      staging: {
        workflow: '.github/workflows/staging.yml',
      },
      deploy_status: {
        kind: 'command',
        command: 'railway status',
      },
      secondary_surfaces: [
        {
          label: 'worker',
          platform: 'github',
          project_type: 'service',
          deploy_status: {
            kind: 'github_actions',
          },
          deploy_workflow: '.github/workflows/worker.yml',
          notes: ['worker deploy is optional'],
        },
      ],
      notes: ['canonical note'],
    });
    writeRepoFile(cwd, 'CLAUDE.md', [
      '## Deploy Configuration',
      '- Platform: fly',
      '- Project type: web app',
    ].join('\n'));

    expect(resolveDeployReadiness(cwd, 'run-123', '2026-01-01T00:00:00.000Z')).toEqual({
      schema_version: 1,
      run_id: 'run-123',
      generated_at: '2026-01-01T00:00:00.000Z',
      configured: true,
      source: 'canonical_contract',
      contract_path: deployContractJsonPath(),
      primary_surface_label: 'api',
      platform: 'railway',
      project_type: 'service',
      production_url: 'https://api.example.com',
      health_check: 'https://api.example.com/health',
      deploy_status_kind: 'command',
      deploy_status_command: 'railway status',
      deploy_workflow: null,
      staging_detected: true,
      secondary_surfaces: [
        {
          label: 'worker',
          platform: 'github_actions',
          project_type: 'service',
          production_url: null,
          health_check: null,
          deploy_status_kind: 'github_actions',
          deploy_status_command: null,
          deploy_workflow: '.github/workflows/worker.yml',
          blocking: false,
          notes: ['worker deploy is optional'],
        },
      ],
      notes: [
        'canonical note',
        'Secondary deploy surfaces detected: worker (github_actions)',
      ],
    });
  });

  test('falls back to unconfigured readiness when no deploy contract is available', () => {
    const cwd = makeTempRepo();

    expect(resolveDeployReadiness(cwd, 'run-123', '2026-01-01T00:00:00.000Z')).toEqual({
      schema_version: 1,
      run_id: 'run-123',
      generated_at: '2026-01-01T00:00:00.000Z',
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
    });
  });
});
