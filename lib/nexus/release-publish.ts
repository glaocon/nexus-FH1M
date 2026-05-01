import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  assertReleaseManifest,
  compareReleaseVersions,
  getPatchLineDirectUpgradeFloor,
  getReleaseNotesPath,
  getReleaseTag,
  type ReleaseManifest,
} from './release-contract';
import { assertString, assertStringArray, isRecord } from './validation-helpers';

export const RELEASE_PREFLIGHT_STATUSES = ['ready', 'blocked'] as const;
export type ReleasePreflightStatus = (typeof RELEASE_PREFLIGHT_STATUSES)[number];

export interface ReleasePreflightReport {
  schema_version: 1;
  status: ReleasePreflightStatus;
  version: string;
  tag: string;
  release_notes_path: string;
  issues: string[];
}

const DEFAULT_RELEASE_REPO = 'LaPaGaYo/nexus' as const;

function assertReleasePreflightStatus(value: unknown): asserts value is ReleasePreflightStatus {
  if (!RELEASE_PREFLIGHT_STATUSES.includes(value as ReleasePreflightStatus)) {
    throw new Error(`release preflight status must be one of: ${RELEASE_PREFLIGHT_STATUSES.join(', ')}`);
  }
}

function getExpectedReleaseNotesPath(manifest: ReleaseManifest, version: string): string | null {
  const publishedDate = new Date(manifest.published_at);
  if (Number.isNaN(publishedDate.getTime())) {
    return null;
  }

  return getReleaseNotesPath(manifest.published_at.slice(0, 10), version);
}

function getExpectedBundleUrl(tag: string): string {
  return `https://github.com/${DEFAULT_RELEASE_REPO}/archive/refs/tags/${tag}.tar.gz`;
}

export function validateReleasePreflightReport(report: unknown): ReleasePreflightReport {
  if (!isRecord(report)) {
    throw new Error('release preflight report must be an object');
  }

  if (report.schema_version !== 1) {
    throw new Error('release preflight report schema_version must be 1');
  }

  assertReleasePreflightStatus(report.status);
  assertString(report.version, 'version');
  assertString(report.tag, 'tag');
  assertString(report.release_notes_path, 'release_notes_path');
  assertStringArray(report.issues, 'issues');

  return report;
}

export function buildReleasePreflightReport(input: {
  rootDir: string;
  gitStatusLines: string[];
  existingTags: string[];
}): ReleasePreflightReport {
  const rootDir = input.rootDir;
  const version = readFileSync(join(rootDir, 'VERSION'), 'utf8').trim();
  const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: unknown };
  const manifest = JSON.parse(readFileSync(join(rootDir, 'release.json'), 'utf8')) as unknown;

  assertReleaseManifest(manifest);

  const expectedTag = getReleaseTag(version);
  const expectedReleaseNotesPath = getExpectedReleaseNotesPath(manifest, version);
  const expectedBundleUrl = getExpectedBundleUrl(expectedTag);
  const issues: string[] = [];

  if (packageJson.version !== version) {
    issues.push(`package.json version ${String(packageJson.version)} does not match VERSION ${version}`);
  }

  if (manifest.version !== version) {
    issues.push(`release.json version ${manifest.version} does not match VERSION ${version}`);
  }

  if (manifest.tag !== expectedTag) {
    issues.push(`release.json tag ${manifest.tag} does not match ${expectedTag}`);
  }

  if (expectedReleaseNotesPath === null) {
    issues.push(`release.json published_at ${manifest.published_at} is not a valid ISO timestamp`);
  } else if (manifest.release_notes_path !== expectedReleaseNotesPath) {
    issues.push(`release.json release_notes_path ${manifest.release_notes_path} does not match expected ${expectedReleaseNotesPath}`);
  }

  if (!existsSync(join(rootDir, manifest.release_notes_path))) {
    issues.push(`release notes missing at ${manifest.release_notes_path}`);
  }

  if (manifest.bundle.url !== expectedBundleUrl) {
    issues.push(`release.json bundle.url ${manifest.bundle.url} does not match expected ${expectedBundleUrl}`);
  }

  const expectedPatchLineUpgradeFloor = getPatchLineDirectUpgradeFloor(version);
  if (
    expectedPatchLineUpgradeFloor !== null
    && compareReleaseVersions(manifest.compatibility.upgrade_from_min_version, expectedPatchLineUpgradeFloor) > 0
  ) {
    issues.push(
      `release.json compatibility.upgrade_from_min_version ${manifest.compatibility.upgrade_from_min_version} exceeds the patch-line direct-upgrade floor ${expectedPatchLineUpgradeFloor}`,
    );
  }

  if (input.gitStatusLines.length > 0) {
    issues.push('dirty worktree blocks release publication');
  }

  if (input.existingTags.includes(expectedTag)) {
    issues.push(`tag ${expectedTag} already exists`);
  }

  return validateReleasePreflightReport({
    schema_version: 1,
    status: issues.length === 0 ? 'ready' : 'blocked',
    version,
    tag: expectedTag,
    release_notes_path: manifest.release_notes_path,
    issues,
  });
}
