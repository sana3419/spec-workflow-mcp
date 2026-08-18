import { promises as fs } from 'fs';
import { PathUtils } from './path-utils.js';
import { SpecParser } from './parser.js';

/**
 * Spec cleanup — pure library extracted from the former dashboard JobScheduler.
 *
 * No scheduling lives here. Callers (CLI `spec-workflow-mcp cleanup`, the Telegram
 * `/cleanup` command, or a user-owned cron/systemd timer) decide *when*; this module
 * only decides *what* is older than the cutoff and (optionally) deletes it.
 */

export interface CleanupOptions {
  /** Delete specs whose createdAt is older than this many days. */
  daysOld: number;
  /** Operate on archived specs instead of active ones. Default: false. */
  archived?: boolean;
  /** Only report what would be deleted. Default: false. */
  dryRun?: boolean;
  /** Reference "now" (injectable for tests). Default: new Date(). */
  now?: Date;
}

export interface CleanupCandidate {
  name: string;
  createdAt: string;
  path: string;
}

export interface CleanupResult {
  processed: number;
  candidates: CleanupCandidate[];
  deleted: string[];
  failed: Array<{ name: string; error: string }>;
  dryRun: boolean;
}

export async function findCleanupCandidates(
  projectPath: string,
  opts: Pick<CleanupOptions, 'daysOld' | 'archived' | 'now'>
): Promise<{ processed: number; candidates: CleanupCandidate[] }> {
  if (!Number.isFinite(opts.daysOld) || opts.daysOld < 0) {
    throw new Error(`daysOld must be a non-negative number, got ${opts.daysOld}`);
  }
  const parser = new SpecParser(projectPath);
  const specs = opts.archived ? await parser.getAllArchivedSpecs() : await parser.getAllSpecs();
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - opts.daysOld * 24 * 60 * 60 * 1000;

  const candidates: CleanupCandidate[] = [];
  for (const spec of specs) {
    const created = new Date(spec.createdAt).getTime();
    if (Number.isFinite(created) && created < cutoff) {
      candidates.push({
        name: spec.name,
        createdAt: spec.createdAt,
        path: opts.archived
          ? PathUtils.getArchiveSpecPath(projectPath, spec.name)
          : PathUtils.getSpecPath(projectPath, spec.name),
      });
    }
  }
  return { processed: specs.length, candidates };
}

export async function cleanupSpecs(projectPath: string, opts: CleanupOptions): Promise<CleanupResult> {
  const { processed, candidates } = await findCleanupCandidates(projectPath, opts);
  const result: CleanupResult = {
    processed,
    candidates,
    deleted: [],
    failed: [],
    dryRun: !!opts.dryRun,
  };
  if (opts.dryRun) return result;

  for (const c of candidates) {
    try {
      await fs.rm(c.path, { recursive: true, force: true });
      result.deleted.push(c.name);
    } catch (e) {
      result.failed.push({ name: c.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
