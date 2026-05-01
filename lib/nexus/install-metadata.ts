import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { assertSupportedReleaseChannel, type SupportedReleaseChannel } from './release-contract';
import { assertNullableString, assertString, isRecord, readJsonFile } from './validation-helpers';

export const INSTALL_METADATA_FILE = '.nexus-install.json' as const;

export const INSTALL_KINDS = [
  'managed_release',
  'managed_vendored',
  'legacy_git',
  'legacy_vendored',
  'source_checkout',
] as const;
export type InstallKind = (typeof INSTALL_KINDS)[number];

export const INSTALL_SCOPES = ['global', 'project'] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

export interface InstallSourceRecord {
  kind: 'github_release';
  repo: string;
  bundle_url: string;
}

export interface InstallMigrationRecord {
  install_kind: Exclude<InstallKind, 'managed_release' | 'managed_vendored'>;
  installed_version: string;
}

export interface InstallMetadata {
  schema_version: 1;
  product: 'nexus';
  install_kind: InstallKind;
  install_scope: InstallScope;
  release_channel: SupportedReleaseChannel;
  installed_version: string;
  installed_tag: string;
  install_source: InstallSourceRecord;
  last_upgrade_at: string | null;
  migrated_from: InstallMigrationRecord | null;
}

const KNOWN_USER_INSTALL_SUFFIXES = [
  '.claude/skills/nexus',
  '.nexus/repos/nexus',
  '.codex/skills/nexus',
  '.kiro/skills/nexus',
  '.factory/skills/nexus',
] as const;

const REPO_LOCAL_VENDORED_SUFFIXES = [
  '.claude/skills/nexus',
] as const;

function assertInstallKind(value: unknown): asserts value is InstallKind {
  if (!INSTALL_KINDS.includes(value as InstallKind)) {
    throw new Error(`install_kind must be one of: ${INSTALL_KINDS.join(', ')}`);
  }
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function matchesInstallSuffix(path: string, suffix: string): boolean {
  const normalizedPath = normalizePathForMatch(path);
  const normalizedSuffix = normalizePathForMatch(suffix);
  return normalizedPath === normalizedSuffix || normalizedPath.endsWith(`/${normalizedSuffix}`);
}

function assertInstallScope(value: unknown): asserts value is InstallScope {
  if (!INSTALL_SCOPES.includes(value as InstallScope)) {
    throw new Error(`install_scope must be one of: ${INSTALL_SCOPES.join(', ')}`);
  }
}

function assertInstallSource(value: unknown): asserts value is InstallSourceRecord {
  if (!isRecord(value)) {
    throw new Error('install_source must be an object');
  }

  if (value.kind !== 'github_release') {
    throw new Error('install_source.kind must be github_release');
  }

  assertString(value.repo, 'install_source.repo');
  assertString(value.bundle_url, 'install_source.bundle_url');
}

function assertMigratedFrom(value: unknown): asserts value is InstallMigrationRecord | null {
  if (value === null) {
    return;
  }

  if (!isRecord(value)) {
    throw new Error('migrated_from must be an object or null');
  }

  if (typeof value.install_kind !== 'string' || value.install_kind.length === 0) {
    throw new Error('migrated_from.install_kind must be a non-empty string');
  }

  if (!INSTALL_KINDS.includes(value.install_kind as InstallKind)) {
    throw new Error(`migrated_from.install_kind must be one of: ${INSTALL_KINDS.join(', ')}`);
  }

  if (value.install_kind === 'managed_release' || value.install_kind === 'managed_vendored') {
    throw new Error('migrated_from.install_kind must be a legacy install kind');
  }

  assertString(value.installed_version, 'migrated_from.installed_version');
}

export function assertInstallMetadata(metadata: unknown): asserts metadata is InstallMetadata {
  if (!isRecord(metadata)) {
    throw new Error('install metadata must be an object');
  }

  if (metadata.schema_version !== 1) {
    throw new Error('install metadata schema_version must be 1');
  }

  if (metadata.product !== 'nexus') {
    throw new Error('install metadata product must be nexus');
  }

  assertInstallKind(metadata.install_kind);
  assertInstallScope(metadata.install_scope);

  assertSupportedReleaseChannel(metadata.release_channel, 'release_channel');

  assertString(metadata.installed_version, 'installed_version');
  assertString(metadata.installed_tag, 'installed_tag');
  assertInstallSource(metadata.install_source);
  assertNullableString(metadata.last_upgrade_at, 'last_upgrade_at');
  assertMigratedFrom(metadata.migrated_from);
}

export function validateInstallMetadata(metadata: unknown): InstallMetadata {
  assertInstallMetadata(metadata);
  return metadata;
}

export function buildManagedReleaseInstallMetadata(input: {
  install_kind?: 'managed_release' | 'managed_vendored';
  install_scope: InstallScope;
  release_channel: SupportedReleaseChannel;
  installed_version: string;
  installed_tag: string;
  install_source: InstallSourceRecord;
  last_upgrade_at: string | null;
  migrated_from: InstallMigrationRecord | null;
}): InstallMetadata {
  const metadata: InstallMetadata = {
    schema_version: 1,
    product: 'nexus',
    install_kind: input.install_kind ?? 'managed_release',
    install_scope: input.install_scope,
    release_channel: input.release_channel,
    installed_version: input.installed_version,
    installed_tag: input.installed_tag,
    install_source: input.install_source,
    last_upgrade_at: input.last_upgrade_at,
    migrated_from: input.migrated_from,
  };

  validateInstallMetadata(metadata);
  return metadata;
}

export function isManagedInstallKind(kind: InstallKind): kind is 'managed_release' | 'managed_vendored' {
  return kind === 'managed_release' || kind === 'managed_vendored';
}

export function isKnownUserInstallRoot(installRoot: string, homeDir = process.env.HOME ?? ''): boolean {
  if (homeDir.length === 0) {
    return false;
  }

  return KNOWN_USER_INSTALL_SUFFIXES.some(suffix => matchesInstallSuffix(installRoot, join(homeDir, suffix)));
}

export function isRepoLocalVendoredInstallRoot(installRoot: string, homeDir = process.env.HOME ?? ''): boolean {
  if (!REPO_LOCAL_VENDORED_SUFFIXES.some(suffix => matchesInstallSuffix(installRoot, suffix))) {
    return false;
  }

  return !isKnownUserInstallRoot(installRoot, homeDir);
}

export function getManagedInstallTarget(installRoot: string, homeDir = process.env.HOME ?? ''): {
  install_kind: 'managed_release' | 'managed_vendored';
  install_scope: InstallScope;
} {
  if (isRepoLocalVendoredInstallRoot(installRoot, homeDir)) {
    return {
      install_kind: 'managed_vendored',
      install_scope: 'project',
    };
  }

  return {
    install_kind: 'managed_release',
    install_scope: 'global',
  };
}

export function readInstallMetadata(installRoot: string): InstallMetadata | null {
  return readJsonFile(getInstallMetadataPath(installRoot), validateInstallMetadata);
}

export function writeInstallMetadata(metadata: InstallMetadata, installRoot: string): void {
  const path = getInstallMetadataPath(installRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

export function getInstallMetadataPath(installRoot: string): string {
  return join(installRoot, INSTALL_METADATA_FILE);
}
