import { describe, expect, test } from 'bun:test';
import {
  formatSidebarAgentError,
  MAX_AGENT_TIMEOUT_MS,
  MIN_AGENT_TIMEOUT_MS,
  parseSidebarAgentTimeoutMs,
  redactProcessStderr,
  sidebarStderrPreview,
} from '../src/sidebar-agent';

describe('sidebar agent safety helpers', () => {
  test('redacts common secret forms from subprocess stderr', () => {
    const stderr = [
      'ANTHROPIC_API_KEY=sk-ant-secretvalue123456',
      'Authorization: Bearer rawbearertoken123456',
      'github token ghp_secretvalue123456',
      'OPENAI_API_KEY="sk-proj-secretvalue123456"',
    ].join('\n');

    const redacted = redactProcessStderr(stderr);

    expect(redacted).not.toContain('sk-ant-secretvalue123456');
    expect(redacted).not.toContain('rawbearertoken123456');
    expect(redacted).not.toContain('ghp_secretvalue123456');
    expect(redacted).not.toContain('sk-proj-secretvalue123456');
    expect(redacted).toContain('[redacted]');
  });

  test('formats agent errors with a redacted bounded stderr preview', () => {
    const stderr = `${'x'.repeat(700)}\nTOKEN=ghp_secretvalue123456\nfinal line`;
    const error = formatSidebarAgentError('spawn failed with sk-ant-message123456', stderr);

    expect(error).toContain('spawn failed with [redacted-secret]');
    expect(error).toContain('stderr:');
    expect(error).toContain('final line');
    expect(error).not.toContain('ghp_secretvalue123456');
    expect(error).not.toContain('sk-ant-message123456');
    expect(sidebarStderrPreview(stderr).length).toBeLessThanOrEqual(500);
  });

  test('bounds sidebar agent timeout env values', () => {
    expect(parseSidebarAgentTimeoutMs(undefined)).toBe(300_000);
    expect(parseSidebarAgentTimeoutMs('not-a-number')).toBe(300_000);
    expect(parseSidebarAgentTimeoutMs('-1')).toBe(300_000);
    expect(parseSidebarAgentTimeoutMs('100')).toBe(MIN_AGENT_TIMEOUT_MS);
    expect(parseSidebarAgentTimeoutMs('300000')).toBe(300_000);
    expect(parseSidebarAgentTimeoutMs('999999999')).toBe(MAX_AGENT_TIMEOUT_MS);
  });
});
