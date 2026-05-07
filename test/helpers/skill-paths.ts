import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  candidateSkillArtifactPathsForName,
  skillNameFromSourcePath,
  type SkillArtifactFileName,
} from '../../lib/nexus/skill-structure';
import { discoverSkillFiles } from '../../scripts/skill/discover-skills';

function fallbackArtifactPath(nameOrDir: string, fileName: SkillArtifactFileName): string {
  if (nameOrDir === '.' || nameOrDir === 'nexus' || nameOrDir === '') {
    return fileName;
  }
  return `${nameOrDir}/${fileName}`;
}

export function skillArtifactPath(root: string, nameOrDir: string, fileName: SkillArtifactFileName = 'SKILL.md'): string {
  let candidates: string[];
  try {
    candidates = candidateSkillArtifactPathsForName(nameOrDir, fileName);
  } catch {
    candidates = [fallbackArtifactPath(nameOrDir, fileName)];
  }

  for (const candidate of candidates) {
    const absolutePath = join(root, candidate);
    if (existsSync(absolutePath)) {
      return absolutePath;
    }
  }

  return join(root, candidates[0] ?? fallbackArtifactPath(nameOrDir, fileName));
}

export function readSkill(root: string, nameOrDir: string): string {
  return readFileSync(skillArtifactPath(root, nameOrDir, 'SKILL.md'), 'utf-8');
}

export function readSkillTemplate(root: string, nameOrDir: string): string {
  return readFileSync(skillArtifactPath(root, nameOrDir, 'SKILL.md.tmpl'), 'utf-8');
}

export function discoverGeneratedSkillArtifacts(root: string): Array<{ name: string; path: string; content: string }> {
  return discoverSkillFiles(root).map((relativePath) => ({
    name: skillNameFromSourcePath(relativePath),
    path: join(root, relativePath),
    content: readFileSync(join(root, relativePath), 'utf-8'),
  }));
}
