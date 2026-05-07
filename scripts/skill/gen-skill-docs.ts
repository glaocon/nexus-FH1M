#!/usr/bin/env bun
/**
 * Generate SKILL.md files from .tmpl templates.
 *
 * Pipeline:
 *   read .tmpl → find {{PLACEHOLDERS}} → resolve from source → format → write .md
 *
 * Supports --dry-run: generate to memory, exit 1 if different from committed file.
 * Used by skill:check and CI freshness checks.
 */

import { COMMAND_DESCRIPTIONS } from '../../runtimes/browse/src/commands';
import { SNAPSHOT_FLAGS } from '../../runtimes/browse/src/snapshot';
import { discoverTemplates } from './discover-skills';
import * as fs from 'fs';
import * as path from 'path';
import type { Host, TemplateContext } from '../resolvers/types';
import { HOST_PATHS } from '../resolvers/types';
import { RESOLVERS } from '../resolvers/index';
import { generatePlanCompletionAuditShip, generatePlanCompletionAuditReview, generatePlanVerificationExec } from '../resolvers/review';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Host Detection ─────────────────────────────────────────

const HOST_ARG = process.argv.find(a => a.startsWith('--host'));
type HostArg = Host | 'all';
const HOST_ARG_VAL: HostArg = (() => {
  if (!HOST_ARG) return 'claude';
  const val = HOST_ARG.includes('=') ? HOST_ARG.split('=')[1] : process.argv[process.argv.indexOf(HOST_ARG) + 1];
  if (val === 'codex' || val === 'agents') return 'codex';
  if (val === 'factory' || val === 'droid') return 'factory';
  if (val === 'gemini-cli' || val === 'gemini') return 'gemini-cli';
  if (val === 'claude') return 'claude';
  if (val === 'all') return 'all';
  throw new Error(`Unknown host: ${val}. Use claude, codex, factory, gemini-cli, gemini, droid, agents, or all.`);
})();

// For single-host mode, HOST is the host. For --host all, it's set per iteration below.
let HOST: Host = HOST_ARG_VAL === 'all' ? 'claude' : HOST_ARG_VAL;

// HostPaths, HOST_PATHS, and TemplateContext imported from ../resolvers/types.

// ─── Shared Design Constants ────────────────────────────────

/** Nexus's 10 AI slop anti-patterns — shared between DESIGN_METHODOLOGY and DESIGN_HARD_RULES */
const AI_SLOP_BLACKLIST = [
  'Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes',
  '**The 3-column feature grid:** icon-in-colored-circle + bold title + 2-line description, repeated 3x symmetrically. THE most recognizable AI layout.',
  'Icons in colored circles as section decoration (SaaS starter template look)',
  'Centered everything (`text-align: center` on all headings, descriptions, cards)',
  'Uniform bubbly border-radius on every element (same large radius on everything)',
  'Decorative blobs, floating circles, wavy SVG dividers (if a section feels empty, it needs better content, not decoration)',
  'Emoji as design elements (rockets in headings, emoji as bullet points)',
  'Colored left-border on cards (`border-left: 3px solid <accent>`)',
  'Generic hero copy ("Welcome to [X]", "Unlock the power of...", "Your all-in-one solution for...")',
  'Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA, every section same height)',
];

/** OpenAI hard rejection criteria (from "Designing Delightful Frontends with GPT-5.4", Mar 2026) */
const OPENAI_HARD_REJECTIONS = [
  'Generic SaaS card grid as first impression',
  'Beautiful image with weak brand',
  'Strong headline with no clear action',
  'Busy imagery behind text',
  'Sections repeating same mood statement',
  'Carousel with no narrative purpose',
  'App UI made of stacked cards instead of layout',
];

/** OpenAI litmus checks — 7 yes/no tests for cross-model consensus scoring */
const OPENAI_LITMUS_CHECKS = [
  'Brand/product unmistakable in first screen?',
  'One strong visual anchor present?',
  'Page understandable by scanning headlines only?',
  'Each section has one job?',
  'Are cards actually necessary?',
  'Does motion improve hierarchy or atmosphere?',
  'Would design feel premium with all decorative shadows removed?',
];

// ─── External Host Helpers ───────────────────────────────────

// Re-export local copy for use in this file (matches codex-helpers.ts)
// Accepts optional frontmatter name to support directory/invocation name divergence
function externalSkillName(skillDir: string, frontmatterName?: string): string {
  // Root skill (skillDir === '' or '.') always maps to 'nexus' regardless of frontmatter
  if (skillDir === '.' || skillDir === '') return 'nexus';
  // The root source may live under skills/root/nexus while still publishing as "nexus".
  if (frontmatterName === 'nexus') return 'nexus';
  // Use frontmatter name when it differs from directory name (e.g., run-tests/ with name: test)
  const baseName = frontmatterName && frontmatterName !== skillDir ? frontmatterName : skillDir;
  if (baseName.startsWith('nexus-')) return baseName;
  return `nexus-${baseName}`;
}

function extractNameAndDescription(content: string): { name: string; description: string } {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return { name: '', description: '' };

  const frontmatter = frontmatterMatch[1] ?? '';
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : '';

  let description = '';
  const lines = frontmatter.split(/\r?\n/);
  let inDescription = false;
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.match(/^description:\s*\|?\s*$/)) {
      inDescription = true;
      continue;
    }
    if (line.match(/^description:\s*\S/)) {
      description = line.replace(/^description:\s*/, '').trim();
      break;
    }
    if (inDescription) {
      if (line === '' || line.match(/^\s/)) {
        descLines.push(line.replace(/^  /, ''));
      } else {
        break;
      }
    }
  }
  if (descLines.length > 0) {
    description = descLines.join('\n').trim();
  }

  return { name, description };
}

const OPENAI_SHORT_DESCRIPTION_LIMIT = 120;

function condenseOpenAIShortDescription(description: string): string {
  const firstParagraph = description.split(/\n\s*\n/)[0] || description;
  const collapsed = firstParagraph.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= OPENAI_SHORT_DESCRIPTION_LIMIT) return collapsed;

  const truncated = collapsed.slice(0, OPENAI_SHORT_DESCRIPTION_LIMIT - 3);
  const lastSpace = truncated.lastIndexOf(' ');
  const safe = lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated;
  return `${safe}...`;
}

function generateOpenAIYaml(displayName: string, shortDescription: string): string {
  return `interface:
  display_name: ${JSON.stringify(displayName)}
  short_description: ${JSON.stringify(shortDescription)}
  default_prompt: ${JSON.stringify(`Use $${displayName} to locate the bundled Nexus skills.`)}
policy:
  allow_implicit_invocation: true
`;
}

/**
 * Transform frontmatter for external hosts.
 * Claude: strips `sensitive:` field (only Factory uses it).
 * Codex/Gemini CLI: keeps name + description only, enforces 1024-char limit.
 * Factory: keeps name + description + user-invocable, conditionally adds disable-model-invocation.
 */
function transformFrontmatter(content: string, host: Host, nameOverride?: string): string {
  if (host === 'claude') {
    // Strip sensitive: field from Claude output (only Factory uses it)
    return content.replace(/^sensitive:\s*true\r?\n/m, '');
  }

  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return content;
  const frontmatter = frontmatterMatch[1] ?? '';
  const body = content.slice(frontmatterMatch[0].length);
  const { name, description } = extractNameAndDescription(content);
  const emittedName = nameOverride ?? name;

  if (host === 'codex' || host === 'gemini-cli') {
    // External host 1024-char description limit — fail build, don't ship broken skills
    const MAX_DESC = 1024;
    if (description.length > MAX_DESC) {
      throw new Error(
        `Codex description for "${emittedName}" is ${description.length} chars (max ${MAX_DESC}). ` +
        `Compress the description in the .tmpl file.`
      );
    }
    const indentedDesc = description.split('\n').map(l => `  ${l}`).join('\n');
    return `---\nname: ${emittedName}\ndescription: |\n${indentedDesc}\n---` + body;
  }

  if (host === 'factory') {
    const sensitive = /^sensitive:\s*true/m.test(frontmatter);
    const indentedDesc = description.split('\n').map(l => `  ${l}`).join('\n');
    let fm = `---\nname: ${emittedName}\ndescription: |\n${indentedDesc}\nuser-invocable: true\n`;
    if (sensitive) fm += `disable-model-invocation: true\n`;
    fm += '---';
    return fm + body;
  }

  return content; // unknown host: passthrough
}

/**
 * Extract hook descriptions from frontmatter for inline safety prose.
 * Returns a description of what the hooks do, or null if no hooks.
 */
function extractHookSafetyProse(tmplContent: string): string | null {
  if (!tmplContent.match(/^hooks:/m)) return null;

  // Parse the hook matchers to build a human-readable safety description
  const matchers: string[] = [];
  const matcherRegex = /matcher:\s*"(\w+)"/g;
  let m;
  while ((m = matcherRegex.exec(tmplContent)) !== null) {
    if (!matchers.includes(m[1])) matchers.push(m[1]);
  }

  if (matchers.length === 0) return null;

  // Build safety prose based on what tools are hooked
  const toolDescriptions: Record<string, string> = {
    Bash: 'check bash commands for destructive operations (rm -rf, DROP TABLE, force-push, git reset --hard, etc.) before execution',
    Edit: 'verify file edits are within the allowed scope boundary before applying',
    Write: 'verify file writes are within the allowed scope boundary before applying',
  };

  const safetyChecks = matchers
    .map(t => toolDescriptions[t] || `check ${t} operations for safety`)
    .join(', and ');

  return `> **Safety Advisory:** This skill includes safety checks that ${safetyChecks}. When using this skill, always pause and verify before executing potentially destructive operations. If uncertain about a command's safety, ask the user for confirmation before proceeding.`;
}

// ─── External Host Config ────────────────────────────────────

interface ExternalHostConfig {
  hostSubdir: string;          // '.agents' | '.factory'
  generateMetadata: boolean;   // true for codex (openai.yaml), false for factory
  descriptionLimit?: number;   // 1024 for codex, undefined for factory
}

const EXTERNAL_HOST_CONFIG: Record<string, ExternalHostConfig> = {
  codex:   { hostSubdir: '.agents',  generateMetadata: true,  descriptionLimit: 1024 },
  factory: { hostSubdir: '.factory', generateMetadata: false },
  'gemini-cli': { hostSubdir: '.gemini', generateMetadata: false, descriptionLimit: 1024 },
};

// ─── Template Processing ────────────────────────────────────

const GENERATED_HEADER = `<!-- AUTO-GENERATED from {{SOURCE}} — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n`;

/**
 * Process external host output: routing, frontmatter, path rewrites, metadata.
 * Shared between Codex and Factory (and future external hosts).
 */
function processExternalHost(
  content: string,
  tmplContent: string,
  host: Host,
  skillDir: string,
  extractedDescription: string,
  ctx: TemplateContext,
  frontmatterName?: string,
): { content: string; outputPath: string; outputDir: string; symlinkLoop: boolean } {
  const config = EXTERNAL_HOST_CONFIG[host];
  if (!config) throw new Error(`No external host config for: ${host}`);

  const name = externalSkillName(skillDir === '.' ? '' : skillDir, frontmatterName);
  const outputDir = path.join(ROOT, config.hostSubdir, 'skills', name);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'SKILL.md');

  // Guard against symlink loops
  let symlinkLoop = false;
  const claudePath = ctx.tmplPath.replace(/\.tmpl$/, '');
  try {
    const resolvedClaude = fs.realpathSync(claudePath);
    const resolvedExternal = fs.realpathSync(path.dirname(outputPath)) + '/' + path.basename(outputPath);
    if (resolvedClaude === resolvedExternal) {
      symlinkLoop = true;
    }
  } catch {
    // realpathSync fails if file doesn't exist yet — no symlink loop
  }

  // Extract hook safety prose BEFORE transforming frontmatter (which strips hooks)
  const safetyProse = extractHookSafetyProse(tmplContent);

  // Transform frontmatter (host-aware)
  let result = transformFrontmatter(content, host, name);

  // Insert safety advisory at the top of the body (after frontmatter)
  if (safetyProse) {
    const bodyStart = result.indexOf('\n---') + 4;
    result = result.slice(0, bodyStart) + '\n' + safetyProse + '\n' + result.slice(bodyStart);
  }

  // Replace hardcoded Claude Nexus paths with host-appropriate paths.
  const pathRewrites: Array<[RegExp, string]> = [
    [/\$HOME\/\.claude\/skills\/nexus\/bin/g, ctx.paths.binDir],
    [/\$HOME\/\.claude\/skills\/nexus\/browse\/dist/g, ctx.paths.browseDir],
    [/\$HOME\/\.claude\/skills\/nexus\/design\/dist/g, ctx.paths.designDir],
    [/\$HOME\/\.claude\/skills\/nexus/g, ctx.paths.skillRoot],
    [/~\/\.claude\/skills\/nexus\/bin/g, ctx.paths.binDir],
    [/~\/\.claude\/skills\/nexus\/browse\/dist/g, ctx.paths.browseDir],
    [/~\/\.claude\/skills\/nexus\/design\/dist/g, ctx.paths.designDir],
    [/~\/\.claude\/skills\/nexus/g, ctx.paths.skillRoot],
    [/\.claude\/skills\/nexus/g, ctx.paths.localSkillRoot],
    [/\.claude\/skills\/review/g, `${config.hostSubdir}/skills/nexus/review`],
    [/\.claude\/skills/g, `${config.hostSubdir}/skills`],
  ];
  for (const [pattern, replacement] of pathRewrites) {
    result = result.replace(pattern, replacement);
  }

  // Factory-only: translate Claude Code tool names to generic phrasing
  if (host === 'factory') {
    result = result.replace(/use the Bash tool/g, 'run this command');
    result = result.replace(/use the Write tool/g, 'create this file');
    result = result.replace(/use the Read tool/g, 'read the file');
    result = result.replace(/use the Agent tool/g, 'dispatch a subagent');
    result = result.replace(/use the Grep tool/g, 'search for');
    result = result.replace(/use the Glob tool/g, 'find files matching');
  }

  // Codex-only: generate openai.yaml metadata
  if (config.generateMetadata && !symlinkLoop) {
    const agentsDir = path.join(outputDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const shortDescription = condenseOpenAIShortDescription(extractedDescription);
    const metadata = generateOpenAIYaml(name, shortDescription);
    fs.writeFileSync(path.join(agentsDir, 'openai.yaml'), metadata);
    if (host === 'codex' && name === 'nexus') {
      const rootAgentsDir = path.join(ROOT, 'agents');
      fs.mkdirSync(rootAgentsDir, { recursive: true });
      const futureCodexHostDir = path.join(ROOT, 'hosts', 'codex');
      fs.mkdirSync(futureCodexHostDir, { recursive: true });
      const hostMetadataPath = path.join(futureCodexHostDir, 'openai.yaml');
      fs.writeFileSync(hostMetadataPath, metadata);

      const rootMetadataPath = path.join(rootAgentsDir, 'openai.yaml');
      const rootMetadataTarget = path.relative(rootAgentsDir, hostMetadataPath).replace(/\\/g, '/');
      let preservesHostMetadataLink = false;
      try {
        const rootMetadataStat = fs.lstatSync(rootMetadataPath);
        preservesHostMetadataLink = rootMetadataStat.isSymbolicLink()
          || fs.readFileSync(rootMetadataPath, 'utf-8').trim().replace(/\\/g, '/') === rootMetadataTarget;
      } catch {
        preservesHostMetadataLink = false;
      }
      if (!preservesHostMetadataLink) {
        fs.writeFileSync(rootMetadataPath, metadata);
      }
    }
  }

  // Phase 5.5 (Track D-D3): copy nexus.skill.yaml manifest to host install
  // path so the SkillRegistry can find it when discovering from any cwd.
  // Without this, /nexus do dispatcher only sees manifests when running from
  // inside the source repo. After this, installed Nexus on any host can route
  // intent → skill via manifest keywords.
  if (!symlinkLoop) {
    const sourceManifest = path.join(ROOT, skillDir, 'nexus.skill.yaml');
    if (fs.existsSync(sourceManifest)) {
      const destManifest = path.join(outputDir, 'nexus.skill.yaml');
      fs.copyFileSync(sourceManifest, destManifest);
    }
  }

  return { content: result, outputPath, outputDir, symlinkLoop };
}

function processTemplate(tmplPath: string, host: Host = 'claude'): { outputPath: string; content: string; symlinkLoop?: boolean } {
  const tmplContent = fs.readFileSync(tmplPath, 'utf-8');
  const relTmplPath = path.relative(ROOT, tmplPath);
  let outputPath = tmplPath.replace(/\.tmpl$/, '');

  // Determine skill directory relative to ROOT
  const skillDir = path.relative(ROOT, path.dirname(tmplPath));

  // Extract skill name from frontmatter early — needed for both TemplateContext and external host output paths.
  // When frontmatter name: differs from directory name (e.g., run-tests/ with name: test),
  // the frontmatter name is used for external skill naming and setup script symlinks.
  const { name: extractedName, description: extractedDescription } = extractNameAndDescription(tmplContent);
  const skillName = extractedName || path.basename(path.dirname(tmplPath));


  // Extract benefits-from list from frontmatter (inline YAML: benefits-from: [a, b])
  const benefitsMatch = tmplContent.match(/^benefits-from:\s*\[([^\]]*)\]/m);
  const benefitsFrom = benefitsMatch
    ? benefitsMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  // Extract preamble-tier from frontmatter (1-4, controls which preamble sections are included)
  const tierMatch = tmplContent.match(/^preamble-tier:\s*(\d+)$/m);
  const preambleTier = tierMatch ? parseInt(tierMatch[1], 10) : undefined;

  const ctx: TemplateContext = { skillName, tmplPath, benefitsFrom, host, paths: HOST_PATHS[host], preambleTier };

  // Replace placeholders (supports parameterized: {{NAME:arg1:arg2}})
  let content = tmplContent.replace(/\{\{(\w+(?::[^}]+)?)\}\}/g, (match, fullKey) => {
    const parts = fullKey.split(':');
    const resolverName = parts[0];
    const args = parts.slice(1);
    const resolver = RESOLVERS[resolverName];
    if (!resolver) throw new Error(`Unknown placeholder {{${resolverName}}} in ${relTmplPath}`);
    return args.length > 0 ? resolver(ctx, args) : resolver(ctx);
  });

  // Check for any remaining unresolved placeholders
  const remaining = content.match(/\{\{(\w+(?::[^}]+)?)\}\}/g);
  if (remaining) {
    throw new Error(`Unresolved placeholders in ${relTmplPath}: ${remaining.join(', ')}`);
  }

  // For Claude: strip sensitive: field (only Factory uses it)
  // For external hosts: route output, transform frontmatter, rewrite paths
  let symlinkLoop = false;
  if (host === 'claude') {
    content = transformFrontmatter(content, host);
  } else {
    const result = processExternalHost(content, tmplContent, host, skillDir, extractedDescription, ctx, extractedName || undefined);
    content = result.content;
    outputPath = result.outputPath;
    symlinkLoop = result.symlinkLoop;
  }

  // Prepend generated header (after frontmatter)
  const header = GENERATED_HEADER.replace('{{SOURCE}}', path.basename(tmplPath));
  const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
  if (fmEnd !== -1) {
    const insertAt = content.indexOf('\n', fmEnd) + 1;
    content = content.slice(0, insertAt) + header + content.slice(insertAt);
  } else {
    content = header + content;
  }

  return { outputPath, content, symlinkLoop };
}

type ProcessedTemplate = ReturnType<typeof processTemplate>;

function compatibilityOutputsForTemplate(tmplPath: string, host: Host, primary: ProcessedTemplate): ProcessedTemplate[] {
  const relTmplPath = path.relative(ROOT, tmplPath).replace(/\\/g, '/');
  if (host !== 'claude' || relTmplPath !== 'skills/root/nexus/SKILL.md.tmpl') {
    return [];
  }

  return [
    {
      ...primary,
      outputPath: path.join(ROOT, 'SKILL.md'),
    },
  ];
}

// ─── Main ───────────────────────────────────────────────────

function findTemplates(): string[] {
  return discoverTemplates(ROOT).map(t => path.join(ROOT, t.tmpl));
}

function repoRelativePath(filePath: string): string {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function normalizeGeneratedContent(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function cleanupLegacyExternalHostOutputs(host: Host): void {
  if (DRY_RUN || host === 'claude') return;

  const config = EXTERNAL_HOST_CONFIG[host];
  if (!config) return;

  const skillsDir = path.join(ROOT, config.hostSubdir, 'skills');
  if (!fs.existsSync(skillsDir)) return;

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('nexus')) {
      fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
    }
  }
}

const ALL_HOSTS: Host[] = ['claude', 'codex', 'factory', 'gemini-cli'];
const hostsToRun: Host[] = HOST_ARG_VAL === 'all' ? ALL_HOSTS : [HOST];
const failures: { host: string; error: Error }[] = [];

for (const currentHost of hostsToRun) {
  HOST = currentHost;

  try {
    let hasChanges = false;
    const tokenBudget: Array<{ skill: string; lines: number; tokens: number }> = [];

    cleanupLegacyExternalHostOutputs(currentHost);

    for (const tmplPath of findTemplates()) {
      // Skip /codex skill for non-Claude hosts (it's a Claude wrapper around codex exec)
      if (currentHost !== 'claude') {
        const dir = path.basename(path.dirname(tmplPath));
        if (dir === 'codex') continue;
      }

      const primaryOutput = processTemplate(tmplPath, currentHost);
      const outputs = [primaryOutput, ...compatibilityOutputsForTemplate(tmplPath, currentHost, primaryOutput)];

      for (const { outputPath, content: rawContent, symlinkLoop } of outputs) {
        const content = normalizeGeneratedContent(rawContent);
        const relOutput = repoRelativePath(outputPath);

        if (symlinkLoop) {
          console.log(`SKIPPED (symlink loop): ${relOutput}`);
        } else if (DRY_RUN) {
          const existing = fs.existsSync(outputPath)
            ? normalizeGeneratedContent(fs.readFileSync(outputPath, 'utf-8'))
            : '';
          if (existing !== content) {
            console.log(`STALE: ${relOutput}`);
            hasChanges = true;
          } else {
            console.log(`FRESH: ${relOutput}`);
          }
        } else {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, content);
          console.log(`GENERATED: ${relOutput}`);
        }

        // Track token budget
        const lines = content.split('\n').length;
        const tokens = Math.round(content.length / 4); // ~4 chars per token
        tokenBudget.push({ skill: relOutput, lines, tokens });
      }
    }

    if (DRY_RUN && hasChanges) {
      console.error(`\nGenerated SKILL.md files are stale (${currentHost} host). Run: bun run gen:skill-docs --host ${currentHost}`);
      if (HOST_ARG_VAL !== 'all') process.exit(1);
      failures.push({ host: currentHost, error: new Error('Stale files detected') });
    }

    // Print token budget summary
    if (!DRY_RUN && tokenBudget.length > 0) {
      tokenBudget.sort((a, b) => b.lines - a.lines);
      const totalLines = tokenBudget.reduce((s, t) => s + t.lines, 0);
      const totalTokens = tokenBudget.reduce((s, t) => s + t.tokens, 0);

      console.log('');
      console.log(`Token Budget (${currentHost} host)`);
      console.log('═'.repeat(60));
      for (const t of tokenBudget) {
        const name = t.skill.replace(/\/SKILL\.md$/, '').replace(/^\.(agents|factory|gemini)\/skills\//, '');
        console.log(`  ${name.padEnd(30)} ${String(t.lines).padStart(5)} lines  ~${String(t.tokens).padStart(6)} tokens`);
      }
      console.log('─'.repeat(60));
      console.log(`  ${'TOTAL'.padEnd(30)} ${String(totalLines).padStart(5)} lines  ~${String(totalTokens).padStart(6)} tokens`);
      console.log('');
    }
  } catch (e) {
    failures.push({ host: currentHost, error: e as Error });
    console.error(`WARNING: ${currentHost} generation failed: ${(e as Error).message}`);
  }
}

// --host all: report failures. Only exit(1) if claude failed.
if (failures.length > 0 && HOST_ARG_VAL === 'all') {
  console.error(`\n${failures.length} host(s) failed: ${failures.map(f => f.host).join(', ')}`);
  if (failures.some(f => f.host === 'claude')) process.exit(1);
}
// Single host dry-run failure already handled above

// After all hosts processed, warn if prefix patches may need re-applying
if (!DRY_RUN) {
  try {
    const configPaths = [
      process.env.NEXUS_STATE_DIR ? path.join(process.env.NEXUS_STATE_DIR, 'config.yaml') : null,
      path.join(process.env.HOME || '', '.nexus', 'config.yaml'),
    ].filter((value): value is string => Boolean(value));

    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue;
      const config = fs.readFileSync(configPath, 'utf-8');
      if (/^skill_prefix:\s*true/m.test(config)) {
        console.log('\nNote: skill_prefix is true. Run nexus-relink to re-apply name: patches.');
        break;
      }
    }
  } catch { /* non-fatal */ }
}
