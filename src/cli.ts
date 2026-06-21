// CLI subcommands invoked by the background loop runner (spec-loop-run.sh).
// These let the HARNESS — not the implementing agent — own task selection and the verdict.
//
//   spec-workflow-mcp pick   <spec> [--project <path>]
//   spec-workflow-mcp verify <spec> --task <id> --signal <green|red|blocked> [opts]
//
// `pick` and `verify` are the SOLE writers of tasks.md state ([ ]→[-]→[x]/[~]).

import { promises as fs } from 'fs';
import { join } from 'path';
import { PathUtils } from './core/path-utils.js';
import { parseTasksFromMarkdown, findNextPendingTask, getTaskById, updateTaskStatus } from './core/task-parser.js';
import { recordVerification, VerifySignal, VerifySource } from './core/verify-core.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function resolveProject(args: string[]): string {
  return flag(args, '--project') || process.cwd();
}

/** pick: choose the next task to work on (resume in-progress first, else next pending),
 *  mark it [-], and print a JSON line the loop script can read. */
export async function runPickCli(args: string[]): Promise<number> {
  const spec = args[0];
  if (!spec) { console.error('usage: pick <spec> [--project <path>]'); return 2; }
  const projectPath = resolveProject(args);
  const tasksFile = join(PathUtils.getSpecPath(PathUtils.translatePath(projectPath), spec), 'tasks.md');

  let content: string;
  try { content = await fs.readFile(tasksFile, 'utf-8'); }
  catch { console.error(`No tasks.md for spec '${spec}'`); return 2; }

  const { tasks } = parseTasksFromMarkdown(content);
  const task = tasks.find(t => t.status === 'in-progress' && !t.isHeader) || findNextPendingTask(tasks);
  if (!task) { console.log(JSON.stringify({ taskId: null })); return 0; }

  if (task.status !== 'in-progress') {
    await fs.writeFile(tasksFile, updateTaskStatus(content, task.id, 'in-progress'), 'utf-8');
  }
  console.log(JSON.stringify({
    taskId: task.id,
    description: task.description,
    engine: task.engine || null,
    tests: task.tests || null,
  }));
  return 0;
}

/** verify: record a harness-derived verdict (source = harness-exec). Sole writer of [x]/[~]. */
export async function runVerifyCli(args: string[]): Promise<number> {
  const spec = args[0];
  const taskId = flag(args, '--task');
  const signal = flag(args, '--signal') as VerifySignal | undefined;
  if (!spec || !taskId || !signal || !['green', 'red', 'blocked'].includes(signal)) {
    console.error('usage: verify <spec> --task <id> --signal <green|red|blocked> [--project p] [--exit-code n] [--scope glob] [--note text] [--max-fix n] [--engine e]');
    return 2;
  }
  const projectPath = resolveProject(args);
  const note = flag(args, '--note');
  const scope = flag(args, '--scope');
  const exitCodeRaw = flag(args, '--exit-code');
  const maxFixRaw = flag(args, '--max-fix');

  // The harness reports red via exit code; synthesize a testResults entry so recordVerification's
  // red-requires-testResults contract is satisfied without the agent supplying structured results.
  const testResults = signal === 'red'
    ? [{ name: scope || 'scoped tests', passed: false, error: note || `tests failed (exit ${exitCodeRaw ?? '?'})` }]
    : [];

  // A green with no scope means there were no scoped tests to run — record it as 'none' so the
  // audit shows it was NOT independently verified (visible self-cert residue), not 'harness-exec'.
  const source: VerifySource = (signal === 'green' && !scope) ? 'none' : 'harness-exec';
  if (source === 'none') {
    console.error(`UNVERIFIED: task ${taskId} has no _Tests scope — marked complete WITHOUT independent verification`);
  }

  const result = await recordVerification({
    projectPath,
    specName: spec,
    taskId,
    signal,
    source,
    maxFixAttempts: maxFixRaw ? Number(maxFixRaw) : undefined,
    testResults,
    fixNote: note,
    engine: flag(args, '--engine'),
    exitCode: exitCodeRaw !== undefined ? Number(exitCodeRaw) : undefined,
    testScope: scope,
    tamperGateOff: args.includes('--tamper-gate-off'),
  });

  // Machine-readable line for the loop script + human message on stderr.
  console.log(JSON.stringify({ outcome: result.outcome, blocked: result.blocked, fixAttempts: result.fixAttempts, maxFixAttempts: result.maxFixAttempts }));
  console.error(result.message);
  return result.ok ? 0 : 1;
}

/** scopes: print the space-joined _Tests selectors of tasks in a given status (default completed).
 *  Used by the loop's regression run (union of completed scopes, one invocation). */
export async function runScopesCli(args: string[]): Promise<number> {
  const spec = args[0];
  if (!spec) { console.error('usage: scopes <spec> [--status completed] [--project p]'); return 2; }
  const status = flag(args, '--status') || 'completed';
  const projectPath = resolveProject(args);
  const tasksFile = join(PathUtils.getSpecPath(PathUtils.translatePath(projectPath), spec), 'tasks.md');
  let content: string;
  try { content = await fs.readFile(tasksFile, 'utf-8'); } catch { return 0; }
  const { tasks } = parseTasksFromMarkdown(content);
  const scopes = tasks.filter(t => t.status === status && t.tests).map(t => t.tests as string);
  console.log([...new Set(scopes)].join(' '));
  return 0;
}

/** Dispatch a CLI subcommand. Returns null if argv is not a recognized subcommand. */
export async function runSubcommand(argv: string[]): Promise<number | null> {
  const [cmd, ...rest] = argv;
  if (cmd === 'pick') return runPickCli(rest);
  if (cmd === 'verify') return runVerifyCli(rest);
  if (cmd === 'scopes') return runScopesCli(rest);
  return null;
}
