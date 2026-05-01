import { join } from 'path';
import { assertBoolean, assertString, isRecord } from './validation-helpers';

export const RELEASE_MANIFEST_FILE = 'release.json' as const;
export const RELEASE_NOTES_DIR = 'docs/releases' as const;

export const RELEASE_CHANNELS = ['stable'] as const;
export const RESERVED_RELEASE_CHANNELS = ['candidate', 'nightly'] as const;
export const KNOWN_RELEASE_CHANNELS = [...RELEASE_CHANNELS, ...RESERVED_RELEASE_CHANNELS] as const;

export type SupportedReleaseChannel = (typeof RELEASE_CHANNELS)[number];
export type ReleaseChannel = (typeof KNOWN_RELEASE_CHANNELS)[number];

export interface ReleaseBundle {
  type: 'tar.gz';
  url: string;
}

export interface ReleaseCompatibility {
  upgrade_from_min_version: string;
  requires_setup: boolean;
}

export interface ReleaseManifest {
  schema_version: 1;
  product: 'nexus';
  version: string;
  tag: string;
  channel: SupportedReleaseChannel;
  published_at: string;
  release_notes_path: string;
  bundle: ReleaseBundle;
  compatibility: ReleaseCompatibility;
}

export interface ParsedReleaseVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseReleaseVersion(version: string): ParsedReleaseVersion | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (match === null) {
    return null;
  }

  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
  };
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = parseReleaseVersion(left);
  const rightParts = parseReleaseVersion(right);

  if (leftParts === null || rightParts === null) {
    throw new Error(`release versions must be strict semver: ${left} vs ${right}`);
  }

  if (leftParts.major !== rightParts.major) {
    return leftParts.major > rightParts.major ? 1 : -1;
  }

  if (leftParts.minor !== rightParts.minor) {
    return leftParts.minor > rightParts.minor ? 1 : -1;
  }

  if (leftParts.patch !== rightParts.patch) {
    return leftParts.patch > rightParts.patch ? 1 : -1;
  }

  return 0;
}

export function getPatchLineDirectUpgradeFloor(version: string): string | null {
  const parsed = parseReleaseVersion(version);
  if (parsed === null || parsed.patch === 0) {
    return null;
  }

  return `${parsed.major}.${parsed.minor}.0`;
}

export function assertSupportedReleaseChannel(value: unknown, label = 'channel'): asserts value is SupportedReleaseChannel {
  if (!RELEASE_CHANNELS.includes(value as SupportedReleaseChannel)) {
    throw new Error(`${label} must be one of: ${RELEASE_CHANNELS.join(', ')}`);
  }
}

export function assertKnownReleaseChannel(value: unknown, label = 'channel'): asserts value is ReleaseChannel {
  if (!KNOWN_RELEASE_CHANNELS.includes(value as ReleaseChannel)) {
    throw new Error(`${label} must be one of: ${KNOWN_RELEASE_CHANNELS.join(', ')}`);
  }
}

export function assertReleaseManifest(manifest: unknown): asserts manifest is ReleaseManifest {
  if (!isRecord(manifest)) {
    throw new Error('release manifest must be an object');
  }

  if (manifest.schema_version !== 1) {
    throw new Error('release manifest schema_version must be 1');
  }

  if (manifest.product !== 'nexus') {
    throw new Error('release manifest product must be nexus');
  }

  assertString(manifest.version, 'version');
  assertString(manifest.tag, 'tag');
  assertString(manifest.published_at, 'published_at');
  assertString(manifest.release_notes_path, 'release_notes_path');
  assertSupportedReleaseChannel(manifest.channel, 'channel');

  if (!isRecord(manifest.bundle)) {
    throw new Error('bundle must be an object');
  }
  assertString(manifest.bundle.type, 'bundle.type');
  assertString(manifest.bundle.url, 'bundle.url');
  if (manifest.bundle.type !== 'tar.gz') {
    throw new Error('bundle.type must be tar.gz');
  }

  if (!isRecord(manifest.compatibility)) {
    throw new Error('compatibility must be an object');
  }
  assertString(manifest.compatibility.upgrade_from_min_version, 'compatibility.upgrade_from_min_version');
  assertBoolean(manifest.compatibility.requires_setup, 'compatibility.requires_setup');
}

export function assertReleaseManifestConsistency(
  manifest: ReleaseManifest,
  expected: ReleaseManifest,
  label = 'release manifest',
): void {
  if (manifest.schema_version !== expected.schema_version) {
    throw new Error(`${label} schema_version ${manifest.schema_version} does not match expected ${expected.schema_version}`);
  }

  if (manifest.product !== expected.product) {
    throw new Error(`${label} product ${manifest.product} does not match expected ${expected.product}`);
  }

  if (manifest.version !== expected.version) {
    throw new Error(`${label} version ${manifest.version} does not match expected ${expected.version}`);
  }

  if (manifest.tag !== expected.tag) {
    throw new Error(`${label} tag ${manifest.tag} does not match expected ${expected.tag}`);
  }

  if (manifest.channel !== expected.channel) {
    throw new Error(`${label} channel ${manifest.channel} does not match expected ${expected.channel}`);
  }

  if (manifest.published_at !== expected.published_at) {
    throw new Error(`${label} published_at ${manifest.published_at} does not match expected ${expected.published_at}`);
  }

  if (manifest.release_notes_path !== expected.release_notes_path) {
    throw new Error(
      `${label} release_notes_path ${manifest.release_notes_path} does not match expected ${expected.release_notes_path}`,
    );
  }

  if (manifest.bundle.type !== expected.bundle.type) {
    throw new Error(`${label} bundle.type ${manifest.bundle.type} does not match expected ${expected.bundle.type}`);
  }

  if (manifest.bundle.url !== expected.bundle.url) {
    throw new Error(`${label} bundle.url ${manifest.bundle.url} does not match expected ${expected.bundle.url}`);
  }

  if (manifest.compatibility.upgrade_from_min_version !== expected.compatibility.upgrade_from_min_version) {
    throw new Error(
      `${label} compatibility.upgrade_from_min_version ${manifest.compatibility.upgrade_from_min_version} does not match expected ${expected.compatibility.upgrade_from_min_version}`,
    );
  }

  if (manifest.compatibility.requires_setup !== expected.compatibility.requires_setup) {
    throw new Error(
      `${label} compatibility.requires_setup ${manifest.compatibility.requires_setup} does not match expected ${expected.compatibility.requires_setup}`,
    );
  }
}

export function getReleaseTag(version: string): string {
  return `v${version}`;
}

export function getReleaseManifestPath(rootDir: string): string {
  return join(rootDir, RELEASE_MANIFEST_FILE);
}

export function getReleaseNotesPath(dateSegment: string, version: string): string {
  return `${RELEASE_NOTES_DIR}/${dateSegment}-nexus-v${version}.md`;
}
