import { promises as fs } from 'fs';
import { join } from 'path';
import { PathUtils } from './path-utils.js';

/**
 * "When did something last happen in this project?" — used to order the Telegram project lists so the
 * repo you are actually working in (or just created) sits at the top instead of wherever the alphabet
 * put it.
 *
 * Cheapest signal that covers every kind of activity: the newest mtime among the spec directories,
 * the audit log (loop runs) and the workflow root itself (a fresh `init.sh`). No file is read.
 */
export async function projectLastActivity(projectPath: string): Promise<number> {
  const root = PathUtils.getWorkflowRoot(projectPath);
  const candidates: string[] = [root, join(root, 'loop-audit.log')];
  const specsDir = join(root, 'specs');
  candidates.push(specsDir);
  try {
    for (const e of await fs.readdir(specsDir, { withFileTypes: true })) {
      if (e.isDirectory()) candidates.push(join(specsDir, e.name));
    }
  } catch { /* no specs yet */ }

  const stats = await Promise.all(candidates.map(p => fs.stat(p).then(s => s.mtimeMs).catch(() => 0)));
  return Math.max(0, ...stats);
}

/** Most recently active first; ties (and unreadable projects) fall back to a stable path order. */
export async function sortProjectsByActivity(projects: string[]): Promise<string[]> {
  const withTime = await Promise.all(projects.map(async p => ({ p, t: await projectLastActivity(p) })));
  return withTime
    .sort((a, b) => b.t - a.t || a.p.localeCompare(b.p))
    .map(x => x.p);
}
