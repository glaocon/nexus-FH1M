/**
 * Server auth security tests — verify security remediation in server.ts
 *
 * Tests are source-level: they read server.ts and verify that auth checks,
 * CORS restrictions, and token removal are correctly in place.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');
const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SERVER_SCRIPT = path.join(REPO_ROOT, 'runtimes/browse/src/server.ts');

// Helper: extract a block of source between two markers
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Marker not found: ${startMarker}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`End marker not found: ${endMarker}`);
  return source.slice(startIdx, endIdx);
}

async function readStartedServerState(tempDir: string, index: number): Promise<{ token: string; mode: number }> {
  const stateFile = path.join(tempDir, `browse-${index}.json`);
  const proc = Bun.spawn([process.execPath, SERVER_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      BROWSE_HEADLESS_SKIP: '1',
      BROWSE_IDLE_TIMEOUT: '600000',
      BROWSE_PORT: '0',
      BROWSE_STATE_FILE: stateFile,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });

  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { token?: unknown };
        return {
          token: typeof state.token === 'string' ? state.token : '',
          mode: fs.statSync(stateFile).mode & 0o777,
        };
      }
      await Bun.sleep(50);
    }

    proc.kill();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : '';
    throw new Error(`Timed out waiting for browse state file. ${stderr}`.trim());
  } finally {
    try {
      proc.kill();
    } catch {
      // Process may already have exited after a startup failure.
    }
    await proc.exited.catch(() => undefined);
  }
}

describe('Server auth security', () => {
  // Test 1: /health response must not leak the auth token
  test('/health response must not contain token field', () => {
    const healthBlock = sliceBetween(SERVER_SRC, "url.pathname === '/health'", "url.pathname === '/refs'");
    // The old pattern was: token: AUTH_TOKEN
    // The new pattern should have a comment indicating token was removed
    expect(healthBlock).not.toContain('token: AUTH_TOKEN');
    expect(healthBlock).toContain('token removed');
  });

  // Test 2: /refs endpoint requires auth via validateAuth
  test('/refs endpoint requires authentication', () => {
    const refsBlock = sliceBetween(SERVER_SRC, "url.pathname === '/refs'", "url.pathname === '/activity/stream'");
    expect(refsBlock).toContain('validateAuth');
  });

  // Test 3: /refs has no wildcard CORS header
  test('/refs has no wildcard CORS header', () => {
    const refsBlock = sliceBetween(SERVER_SRC, "url.pathname === '/refs'", "url.pathname === '/activity/stream'");
    expect(refsBlock).not.toContain("'*'");
  });

  // Test 4: /activity/history requires auth via validateAuth
  test('/activity/history requires authentication', () => {
    const historyBlock = sliceBetween(SERVER_SRC, "url.pathname === '/activity/history'", 'Sidebar endpoints');
    expect(historyBlock).toContain('validateAuth');
  });

  // Test 5: /activity/history has no wildcard CORS header
  test('/activity/history has no wildcard CORS header', () => {
    const historyBlock = sliceBetween(SERVER_SRC, "url.pathname === '/activity/history'", 'Sidebar endpoints');
    expect(historyBlock).not.toContain("'*'");
  });

  // Test 6: /activity/stream requires auth (inline Bearer or ?token= check)
  test('/activity/stream requires authentication with inline token check', () => {
    const streamBlock = sliceBetween(SERVER_SRC, "url.pathname === '/activity/stream'", "url.pathname === '/activity/history'");
    expect(streamBlock).toContain('validateAuth');
    expect(streamBlock).toContain('AUTH_TOKEN');
    // Should not have wildcard CORS for the SSE stream
    expect(streamBlock).not.toContain("Access-Control-Allow-Origin': '*'");
  });

  test('AUTH_TOKEN rotation is documented as per-process state', () => {
    const authTokenIndex = SERVER_SRC.indexOf('const AUTH_TOKEN = crypto.randomUUID()');
    expect(authTokenIndex).toBeGreaterThan(0);
    const authBlock = SERVER_SRC.slice(Math.max(0, authTokenIndex - 260), authTokenIndex + 80);
    expect(authBlock).toContain('Intentionally per-process');
    expect(authBlock).toContain('state file');
    expect(authBlock).toContain('crypto.randomUUID()');
  });

  test('AUTH_TOKEN rotates across server starts and state file is private', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-server-auth-'));
    try {
      const first = await readStartedServerState(tempDir, 1);
      const second = await readStartedServerState(tempDir, 2);

      expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
      expect(second.token).toMatch(/^[0-9a-f-]{36}$/);
      expect(second.token).not.toBe(first.token);
      if (process.platform === 'win32') {
        expect(first.mode & 0o600).toBe(0o600);
        expect(second.mode & 0o600).toBe(0o600);
      } else {
        expect(first.mode).toBe(0o600);
        expect(second.mode).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
