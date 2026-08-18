// CLI subcommands invoked by the background loop runner (spec-loop-run.sh).
// These let the HARNESS — not the implementing agent — own task selection and the verdict.
//
//   spec-workflow-mcp pick   <spec> [--project <path>]
//   spec-workflow-mcp verify <spec> --task <id> --signal <green|red|blocked> [opts]
//   spec-workflow-mcp stop|status|reset|set-status|cleanup ...   (humans / Telegram daemon)
//
// `pick` and `verify` are the SOLE writers of tasks.md state ([ ]→[-]→[x]/[~]).

import { promises as fs } from 'fs';
import { join } from 'path';
import { PathUtils } from './core/path-utils.js';
import { parseTasksFromMarkdown, findNextPendingTask, getTaskById, updateTaskStatus } from './core/task-parser.js';
import { recordVerification, recordJudgeVerdict, setTaskStatus, VerifySignal, VerifySource, FailureClass, ManualTaskStatus } from './core/verify-core.js';
import { getLoopStatus, requestLoopStop } from './core/run-state.js';
import { cleanupSpecs } from './core/cleanup.js';
import { SpecParser } from './core/parser.js';
import { routeReview } from './core/review-router.js';
import { gateHmac, verifyPendingSig } from './core/gates.js';
import { createHmac } from 'crypto';

const SPEC_NAME = /^[A-Za-z0-9._-]{1,64}$/;
function badSpec(spec: string | undefined): boolean { return !spec || !SPEC_NAME.test(spec) || spec === '.' || spec === '..'; }
import { templateAgentsDir } from './tools/review-route.js';

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
    verify: task.verify || null,
  }));
  return 0;
}

/** verify: record a harness-derived verdict (source = harness-exec). Sole writer of [x]/[~]. */
export async function runVerifyCli(args: string[]): Promise<number> {
  const spec = args[0];
  const taskId = flag(args, '--task');
  const signal = flag(args, '--signal') as VerifySignal | undefined;
  if (!spec || !taskId || !signal || !['green', 'red', 'blocked'].includes(signal)) {
    console.error('usage: verify <spec> --task <id> --signal <green|red|blocked> [--project p] [--exit-code n] [--scope glob] [--note text] [--max-fix n] [--engine e] [--failure-class c]');
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
    failureClass: flag(args, '--failure-class') as FailureClass | undefined,
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

/** judge-record: persist an L2 adequacy-judge verdict (loop runs the judge processes, records here). */
export async function runJudgeRecordCli(args: string[]): Promise<number> {
  const spec = args[0];
  const taskId = flag(args, '--task');
  const verdict = flag(args, '--verdict') as 'pass' | 'fail' | 'skipped' | undefined;
  if (!spec || !taskId || !verdict || !['pass', 'fail', 'skipped'].includes(verdict)) {
    console.error('usage: judge-record <spec> --task <id> --verdict <pass|fail|skipped> [--engine e] [--reasons text] [--max n] [--project p]');
    return 2;
  }
  const maxRaw = flag(args, '--max');
  const result = await recordJudgeVerdict({
    projectPath: resolveProject(args),
    specName: spec,
    taskId,
    engine: flag(args, '--engine') || 'unknown',
    verdict,
    reasons: flag(args, '--reasons'),
    judgeMaxAttempts: maxRaw ? Number(maxRaw) : undefined,
  });
  console.log(JSON.stringify({ outcome: result.outcome, attempts: result.attempts }));
  console.error(result.message);
  return result.ok ? 0 : 1;
}


/** stop: request a running loop to stop (writes specs/<spec>/.run/stop, JSON with by/at/nonce). */
export async function runStopCli(args: string[]): Promise<number> {
  const spec = args[0];
  if (badSpec(spec)) { console.error('usage: stop <spec> [--by who] [--project p]  (spec: [A-Za-z0-9._-]{1,64})'); return 2; }
  const projectPath = resolveProject(args);
  const status = await getLoopStatus(projectPath, spec);
  const req = await requestLoopStop(projectPath, spec, flag(args, '--by') || 'cli');
  console.log(JSON.stringify({ requested: true, running: status.running, pid: status.pid ?? null, nonce: req.nonce }));
  console.error(status.running ? `Stop requested for '${spec}' (pid ${status.pid}); it exits after the current iteration.` : `No loop running for '${spec}' (stop file written; the next run clears it at START).`);
  return 0;
}

/** status: loop + task progress for one spec, or all specs of the project. */
export async function runStatusCli(args: string[]): Promise<number> {
  const projectPath = resolveProject(args);
  const parser = new SpecParser(projectPath);
  if (args[0] && !args[0].startsWith('--') && badSpec(args[0])) { console.error('invalid spec name'); return 2; }
  const specs = args[0] && !args[0].startsWith('--') ? [await parser.getSpec(args[0])] : await parser.getAllSpecs();
  const out = [];
  for (const s of specs) {
    if (!s) continue;
    const loop = await getLoopStatus(projectPath, s.name);
    out.push({ spec: s.name, tasks: s.taskProgress ?? null, loop });
  }
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

/** reset / set-status: manual task-state transition through verify-core (refused while loop runs). */
export async function runSetStatusCli(args: string[], fixed?: ManualTaskStatus): Promise<number> {
  const spec = args[0];
  const taskId = flag(args, '--task');
  const status = (fixed || flag(args, '--status')) as ManualTaskStatus | undefined;
  if (badSpec(spec) || !taskId || !status || !['pending', 'in-progress', 'completed', 'blocked'].includes(status)) {
    console.error('usage: set-status <spec> --task <id> --status <pending|in-progress|completed|blocked> [--reason r] [--by who] [--force] [--project p]\n       reset <spec> --task <id>   (= --status pending)');
    return 2;
  }
  const r = await setTaskStatus({
    projectPath: resolveProject(args), specName: spec, taskId, status,
    reason: flag(args, '--reason'), by: flag(args, '--by') || 'cli', force: args.includes('--force'),
  });
  console.log(JSON.stringify({ ok: r.ok, previous: r.previous ?? null }));
  console.error(r.message);
  return r.ok ? 0 : 1;
}

/** cleanup: delete specs older than N days (active or --archived). Dry-run by default unless --yes. */
export async function runCleanupCli(args: string[]): Promise<number> {
  const daysRaw = flag(args, '--older-than');
  const days = daysRaw ? Number(String(daysRaw).replace(/d$/i, '')) : NaN;
  if (!Number.isFinite(days) || days < 0) { console.error('usage: cleanup --older-than <days> [--archived] [--yes] [--project p]'); return 2; }
  const r = await cleanupSpecs(resolveProject(args), { daysOld: days, archived: args.includes('--archived'), dryRun: !args.includes('--yes') });
  console.log(JSON.stringify(r, null, 2));
  if (r.dryRun) console.error(`Dry run: ${r.candidates.length} of ${r.processed} spec(s) would be deleted. Add --yes to delete.`);
  else console.error(`Deleted ${r.deleted.length}, failed ${r.failed.length}.`);
  return r.failed.length ? 1 : 0;
}

/** route: dry-run reviewer selection for a diff (deterministic; prints agents + reasons). */
export async function runRouteCli(args: string[]): Promise<number> {
  const list = (n: string) => flag(args, n)?.split(',').map(s => s.trim()).filter(Boolean);
  const r = await routeReview({
    projectPath: resolveProject(args),
    base: flag(args, '--base'),
    changedFiles: list('--files'),
    agents: list('--agents'), add: list('--add'), skip: list('--skip'), tags: list('--tags'),
    full: args.includes('--full'),
    maxAgents: flag(args, '--max-agents') ? Number(flag(args, '--max-agents')) : undefined,
  }, templateAgentsDir());
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  if (args.includes('--names')) { for (const s of r.selected) console.log(s.name); return 0; }
  if (r.gitError) console.log(`⚠ ${r.gitError}`);
  console.log(`changed files: ${r.changedFiles.length}${r.docsOnly ? ' (docs only)' : ''} · profile: ${[...r.profile.languages, ...r.profile.frameworks].join(',') || '-'}${r.profile.hasLlmSdk ? ',llm' : ''}${r.profile.hasMigrations ? ',migrations' : ''}${r.profile.hasIac ? ',iac' : ''} · agents dir: ${r.agentsDir}`);
  for (const s of r.selected) console.log(`  ✓ ${s.name.padEnd(28)} T${s.tier}  ${s.reasons.join('; ')}`);
  for (const s of r.skipped) console.log(`  – ${s.name.padEnd(28)}     ${s.why}`);
  if (!r.selected.length) console.log('  (nothing selected)');
  return 0;
}

/** gate-hmac / gate-sign / gate-verify-pending: HMAC helpers for the bash runner. The secret is read
 *  from the GATE_SECRET environment variable ONLY (never argv → never visible in `ps`). */
export async function runGateHmacCli(args: string[], mode: 'decision' | 'sign' | 'verify-pending'): Promise<number> {
  const secret = process.env.GATE_SECRET;
  if (!secret) { console.error('GATE_SECRET env var required'); return 2; }
  if (mode === 'decision') {
    const [id, nonce, decision, by, at] = args;
    if (!id || !nonce || (decision !== 'approve' && decision !== 'reject') || !by || !at) { console.error('usage: gate-hmac <id> <nonce> <approve|reject> <by> <at>'); return 2; }
    console.log(gateHmac(secret, id, nonce, decision, by, at));
    return 0;
  }
  if (mode === 'sign') {
    const [id, nonce, kind, at] = args;
    if (!id || !nonce || !kind || !at) { console.error('usage: gate-sign <id> <nonce> <kind> <createdAt>'); return 2; }
    console.log(createHmac('sha256', secret).update(`${id}:${nonce}:${kind}:${at}`).digest('hex'));
    return 0;
  }
  const file = args[0];
  if (!file) { console.error('usage: gate-verify-pending <file>'); return 2; }
  try {
    const g = JSON.parse(await fs.readFile(file, 'utf-8'));
    const ok = verifyPendingSig(g, secret);
    console.log(ok ? 'valid' : 'invalid');
    return ok ? 0 : 1;
  } catch (e) { console.error(`cannot read ${file}: ${(e as Error).message}`); return 2; }
}

/** Dispatch a CLI subcommand. Returns null if argv is not a recognized subcommand. */
export async function runSubcommand(argv: string[]): Promise<number | null> {
  const [cmd, ...rest] = argv;
  if (cmd === 'pick') return runPickCli(rest);
  if (cmd === 'verify') return runVerifyCli(rest);
  if (cmd === 'scopes') return runScopesCli(rest);
  if (cmd === 'judge-record') return runJudgeRecordCli(rest);
  if (cmd === 'stop') return runStopCli(rest);
  if (cmd === 'status') return runStatusCli(rest);
  if (cmd === 'set-status') return runSetStatusCli(rest);
  if (cmd === 'reset') return runSetStatusCli(rest, 'pending');
  if (cmd === 'cleanup') return runCleanupCli(rest);
  if (cmd === 'route') return runRouteCli(rest);
  if (cmd === 'gate-hmac') return runGateHmacCli(rest, 'decision');
  if (cmd === 'gate-sign') return runGateHmacCli(rest, 'sign');
  if (cmd === 'gate-verify-pending') return runGateHmacCli(rest, 'verify-pending');
  return null;
}
