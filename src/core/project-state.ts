import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

/**
 * Per-project setup state, so nothing has to re-detect it on every session start.
 *
 *   ~/.spec-workflow/projects.json   { "<abs path>": { "status": …, "at": …, "note"? } }
 *
 * `init.sh` records `initialized`, the SessionStart hook records `pending`/`ignored` the first time it
 * sees a directory, and from then on the hook is a single key lookup — no filesystem probing, no
 * repeated prompts. The file is advisory: `project forget` drops an entry and the next session
 * re-detects, which is the escape hatch when a project is re-created or moved.
 */

export type ProjectStatus = 'initialized' | 'pending' | 'ignored';

export interface ProjectStateEntry {
  status: ProjectStatus;
  /** when the status was recorded */
  at: string;
  /** free note (e.g. which version of init.sh ran) */
  note?: string;
}

export const PROJECTS_FILE = join(homedir(), '.spec-workflow', 'projects.json');

export async function readProjectStates(file: string = PROJECTS_FILE): Promise<Record<string, ProjectStateEntry>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, ProjectStateEntry> : {};
  } catch { return {}; }
}

export async function getProjectState(projectPath: string, file: string = PROJECTS_FILE): Promise<ProjectStateEntry | null> {
  return (await readProjectStates(file))[resolve(projectPath)] ?? null;
}

export async function setProjectState(projectPath: string, status: ProjectStatus, note?: string, file: string = PROJECTS_FILE): Promise<ProjectStateEntry> {
  const all = await readProjectStates(file);
  const entry: ProjectStateEntry = { status, at: new Date().toISOString(), ...(note ? { note } : {}) };
  all[resolve(projectPath)] = entry;
  await writeStates(all, file);
  return entry;
}

export async function forgetProject(projectPath: string, file: string = PROJECTS_FILE): Promise<boolean> {
  const all = await readProjectStates(file);
  const key = resolve(projectPath);
  if (!(key in all)) return false;
  delete all[key];
  await writeStates(all, file);
  return true;
}

async function writeStates(all: Record<string, ProjectStateEntry>, file: string): Promise<void> {
  await fs.mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
