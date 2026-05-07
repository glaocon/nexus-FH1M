/**
 * Live E2E test watcher dashboard.
 *
 * Reads heartbeat (e2e-live.json) for current test status and
 * partial eval results (_partial-e2e.json) for completed tests.
 * Renders a terminal dashboard every 1s.
 *
 * Usage: bun run eval:watch [--tail]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getPrimaryDevRoot } from '../../lib/nexus/support-surface';

const HOME_DIR = os.homedir();
const PRIMARY_DEV_DIR = getPrimaryDevRoot(HOME_DIR);
const STALE_THRESHOLD_SEC = 600; // 10 minutes

function resolveReadableDevPath(...segments: string[]): { path: string; devRoot: string } {
  const primaryPath = path.join(PRIMARY_DEV_DIR, ...segments);

  if (fs.existsSync(primaryPath)) {
    return { path: primaryPath, devRoot: PRIMARY_DEV_DIR };
  }

  return { path: primaryPath, devRoot: PRIMARY_DEV_DIR };
}

export interface HeartbeatData {
  runId: string;
  pid?: number;
  startedAt: string;
  currentTest: string;
  status: string;
  turn: number;
  toolCount: number;
  lastTool: string;
  lastToolAt: string;
  elapsedSec: number;
}

export interface PartialData {
  tests: Array<{
    name: string;
    passed: boolean;
    cost_usd: number;
    duration_ms: number;
    turns_used?: number;
    exit_reason?: string;
  }>;
  total_cost_usd: number;
  _partial?: boolean;
}

/** Read and parse a JSON file, returning null on any error. */
function readJSON<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Check if a process is alive (signal 0 = existence check, doesn't kill). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Format seconds as Xm Ys */
function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/** Render dashboard from heartbeat + partial data. Pure function for testability. */
export function renderDashboard(
  heartbeat: HeartbeatData | null,
  partial: PartialData | null,
  devRoot: string = PRIMARY_DEV_DIR,
): string {
  const lines: string[] = [];
  const heartbeatPath = path.join(devRoot, 'e2e-live.json');
  const partialPath = path.join(devRoot, 'evals', '_partial-e2e.json');

  if (!heartbeat && !partial) {
    lines.push('E2E Watch — No active run detected');
    lines.push('');
    lines.push(`Heartbeat: ${heartbeatPath} (not found)`);
    lines.push(`Partial:   ${partialPath} (not found)`);
    lines.push('');
    lines.push('Start a run with: EVALS=1 bun test test/skill-e2e-*.test.ts');
    return lines.join('\n');
  }

  const runId = heartbeat?.runId || 'unknown';
  const elapsed = heartbeat?.elapsedSec || 0;
  lines.push(`E2E Watch \u2014 Run ${runId} \u2014 ${formatDuration(elapsed)}`);
  lines.push('\u2550'.repeat(55));

  // Completed tests from partial
  if (partial?.tests) {
    for (const t of partial.tests) {
      const icon = t.passed ? '\u2713' : '\u2717';
      const cost = `$${t.cost_usd.toFixed(2)}`;
      const dur = `${Math.round(t.duration_ms / 1000)}s`;
      const turns = t.turns_used !== undefined ? `${t.turns_used} turns` : '';
      const name = t.name.length > 30 ? t.name.slice(0, 27) + '...' : t.name.padEnd(30);
      lines.push(` ${icon} ${name}  ${cost.padStart(6)}  ${dur.padStart(5)}  ${turns}`);
    }
  }

  // Current test from heartbeat
  if (heartbeat && heartbeat.status === 'running') {
    const name = heartbeat.currentTest.length > 30
      ? heartbeat.currentTest.slice(0, 27) + '...'
      : heartbeat.currentTest.padEnd(30);
    lines.push(` \u29D6 ${name}  ${formatDuration(heartbeat.elapsedSec).padStart(6)}  turn ${heartbeat.turn}   last: ${heartbeat.lastTool}`);

    // Stale detection
    const lastToolTime = new Date(heartbeat.lastToolAt).getTime();
    const staleSec = Math.round((Date.now() - lastToolTime) / 1000);
    if (staleSec > STALE_THRESHOLD_SEC) {
      lines.push(` \u26A0  STALE: last tool call was ${formatDuration(staleSec)} ago \u2014 run may have crashed`);
    }
  }

  lines.push('\u2500'.repeat(55));

  // Summary
  const completedCount = partial?.tests?.length || 0;
  const totalCost = partial?.total_cost_usd || 0;
  const running = heartbeat?.status === 'running' ? 1 : 0;
  lines.push(` Completed: ${completedCount}  Running: ${running}  Cost: $${totalCost.toFixed(2)}  Elapsed: ${formatDuration(elapsed)}`);

  if (heartbeat?.runId) {
    const logPath = path.join(devRoot, 'e2e-runs', heartbeat.runId, 'progress.log');
    lines.push(` Logs: ${logPath}`);
  }

  return lines.join('\n');
}

// --- Main ---

if (import.meta.main) {
  const showTail = process.argv.includes('--tail');

  const render = () => {
    const heartbeatSource = resolveReadableDevPath('e2e-live.json');
    let heartbeat = readJSON<HeartbeatData>(heartbeatSource.path);
    const partialSource = resolveReadableDevPath('evals', '_partial-e2e.json');
    const partial = readJSON<PartialData>(partialSource.path);
    const activeDevRoot = heartbeat ? heartbeatSource.devRoot : partialSource.devRoot;

    // Auto-clear heartbeat if the process is dead
    if (heartbeat?.pid && !isProcessAlive(heartbeat.pid)) {
      try { fs.unlinkSync(heartbeatSource.path); } catch { /* already gone */ }
      process.stdout.write('\x1B[2J\x1B[H');
      process.stdout.write(`Cleared stale heartbeat — PID ${heartbeat.pid} is no longer running.\n\n`);
      heartbeat = null;
    }

    // Clear screen
    process.stdout.write('\x1B[2J\x1B[H');
    process.stdout.write(renderDashboard(heartbeat, partial, activeDevRoot) + '\n');

    // --tail: show last 10 lines of progress.log
    if (showTail && heartbeat?.runId) {
      const logPath = path.join(activeDevRoot, 'e2e-runs', heartbeat.runId, 'progress.log');
      try {
        const content = fs.readFileSync(logPath, 'utf-8');
        const tail = content.split('\n').filter(l => l.trim()).slice(-10);
        process.stdout.write('\nRecent progress:\n');
        for (const line of tail) {
          process.stdout.write(line + '\n');
        }
      } catch { /* log file may not exist yet */ }
    }
  };

  render();
  setInterval(render, 1000);
}
