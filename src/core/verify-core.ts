import { promises as fs } from 'fs';
import { join } from 'path';
import { PathUtils } from './path-utils.js';
import { parseTasksFromMarkdown, getTaskById, updateTaskStatus } from './task-parser.js';
import { VerifyResult } from '../types.js';
import { ENGINE_DEFAULTS } from '../config.js';

export type VerifySignal = 'green' | 'red' | 'blocked';
export type VerifySource = 'harness-exec' | 'agent' | 'none';
export type FailureClass = 'test-fail' | 'build-fail' | 'env' | 'timeout';

export interface RecordVerificationArgs {
  projectPath: string;
  specName: string;
  taskId: string;
  signal: VerifySignal;
  /** Where the verdict came from. 'harness-exec' = loop ran the tests; 'agent' = self-reported. */
  source: VerifySource;
  /** Max red attempts before the task is auto-blocked (engine.maxFixAttempts; default 5). */
  maxFixAttempts?: number;
  testResults?: Array<{ name: string; passed: boolean; error?: string }>;
  /** Free-text note for red, or the reason a 'blocked' verdict is recorded. */
  fixNote?: string;
  engine?: string;
  exitCode?: number;
  testScope?: string;
  /** True when the L1 tamper gate was degraded (non-git) for this verdict — recorded durably. */
  tamperGateOff?: boolean;
  /** Harness-authored classification of a red (test-fail | build-fail | env | timeout). */
  failureClass?: FailureClass;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number } | null;
}

export interface RecordVerificationResult {
  ok: boolean;
  message: string;
  outcome: 'green' | 'red' | 'blocked';
  blocked: boolean;
  fixAttempts: number;
  maxFixAttempts: number;
  testResults?: Array<{ name: string; passed: boolean; error?: string }>;
}

/**
 * Single source of truth for recording a task verdict. Used by the verify-task MCP tool
 * (source: 'agent') and by the loop's `verify` CLI subcommand (source: 'harness-exec').
 * Owns ALL task-state transitions to [x]/[~] plus the verify-results journal and usage log.
 */
/**
 * The verify-results journal on disk. This module is the sole writer, so the file
 * naming and the empty-record shape live here and nowhere else — `readVerifyResult`
 * is the read-only door for other layers (e.g. the Telegram task card).
 */
export function verifyResultFile(specPath: string, taskId: string): string {
  return join(specPath, 'verify-results', `task-${taskId.replace(/\./g, '-')}.json`);
}

async function openVerifyResult(specPath: string, specName: string, taskId: string): Promise<{ file: string; data: VerifyResult }> {
  await fs.mkdir(join(specPath, 'verify-results'), { recursive: true });
  const file = verifyResultFile(specPath, taskId);
  return { file, data: (await readVerifyResult(specPath, specName, taskId)) };
}

/** Read a task's journal entry, or the empty record if it has none yet. */
export async function readVerifyResult(specPath: string, specName: string, taskId: string): Promise<VerifyResult> {
  try {
    return JSON.parse(await fs.readFile(verifyResultFile(specPath, taskId), 'utf-8')) as VerifyResult;
  } catch {
    return { taskId, specName, fixAttempts: 0, lastSignal: null, lastTestResults: [], lastFixNote: '', lastTimestamp: '' };
  }
}

async function saveVerifyResult(file: string, data: VerifyResult): Promise<void> {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}

export async function recordVerification(args: RecordVerificationArgs): Promise<RecordVerificationResult> {
  const {
    projectPath, specName, taskId, signal, source,
    testResults = [], fixNote, engine, exitCode, testScope, tamperGateOff, usage, failureClass,
  } = args;
  const maxFixAttempts = args.maxFixAttempts ?? ENGINE_DEFAULTS.maxFixAttempts;

  if (!/^\d+(\.\d+)*$/.test(taskId)) {
    return fail(`Invalid taskId format: '${taskId}'. Must be digits and dots (e.g., '1', '1.1').`, maxFixAttempts);
  }
  if (signal === 'red' && (!testResults || testResults.length === 0)) {
    return fail('testResults is required when signal is red', maxFixAttempts);
  }

  const specPath = PathUtils.getSpecPath(projectPath, specName);
  const tasksFile = join(specPath, 'tasks.md');

  let tasksContent: string;
  try {
    tasksContent = await fs.readFile(tasksFile, 'utf-8');
  } catch {
    return fail(`Tasks file not found for spec '${specName}'`, maxFixAttempts);
  }

  const parseResult = parseTasksFromMarkdown(tasksContent);
  const task = getTaskById(parseResult.tasks, taskId);
  if (!task) {
    return fail(`Task '${taskId}' not found in spec '${specName}'`, maxFixAttempts);
  }
  const effEngine = engine || task.engine;

  const { file: verifyFile, data: verifyData } = await openVerifyResult(specPath, specName, taskId);

  // Reset fixAttempts if the task was dragged back to pending (recovery scenario)
  if (task.status === 'pending') verifyData.fixAttempts = 0;

  const stamp = () => {
    verifyData.lastTestResults = testResults;
    verifyData.lastFixNote = fixNote || '';
    verifyData.lastTimestamp = new Date().toISOString();
    verifyData.verifiedBy = source;
    if (exitCode !== undefined) verifyData.exitCode = exitCode;
    if (testScope !== undefined) verifyData.testScope = testScope;
    if (tamperGateOff) verifyData.tamperGate = 'off';
    if (signal === 'red') verifyData.failureClass = failureClass; else delete verifyData.failureClass;
  };

  if (signal === 'green') {
    await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, 'completed'), 'utf-8');
    verifyData.lastSignal = 'green';
    stamp();
    await saveVerifyResult(verifyFile, verifyData);
    await appendUsageLog(projectPath, usageEntry(specName, taskId, task.description, effEngine, 'green', verifyData.lastTimestamp, usage));
    return { ok: true, message: `Task '${taskId}' verified GREEN (${source}) - marked completed`, outcome: 'green', blocked: false, fixAttempts: verifyData.fixAttempts, maxFixAttempts };
  }

  if (signal === 'blocked') {
    // Direct block (tamper gate / agent-reported blocker) — does not consume fix attempts.
    const reason = fixNote || 'Blocked - manual intervention required';
    await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, 'blocked', reason), 'utf-8');
    verifyData.lastSignal = 'red';
    stamp();
    await saveVerifyResult(verifyFile, verifyData);
    await appendUsageLog(projectPath, usageEntry(specName, taskId, task.description, effEngine, 'blocked', verifyData.lastTimestamp, usage));
    return { ok: true, message: `Task '${taskId}' BLOCKED: ${reason}`, outcome: 'blocked', blocked: true, fixAttempts: verifyData.fixAttempts, maxFixAttempts };
  }

  // red
  verifyData.fixAttempts += 1;
  verifyData.lastSignal = 'red';
  stamp();
  if (verifyData.fixAttempts >= maxFixAttempts) {
    const reason = `Verification failed ${verifyData.fixAttempts} times, manual intervention required`;
    await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, 'blocked', reason), 'utf-8');
    await saveVerifyResult(verifyFile, verifyData);
    await appendUsageLog(projectPath, usageEntry(specName, taskId, task.description, effEngine, 'blocked', verifyData.lastTimestamp, usage));
    return { ok: true, message: `Task '${taskId}' BLOCKED after ${verifyData.fixAttempts} failed attempts`, outcome: 'blocked', blocked: true, fixAttempts: verifyData.fixAttempts, maxFixAttempts };
  }
  await saveVerifyResult(verifyFile, verifyData);
  return { ok: true, message: `Task '${taskId}' verified RED (${source}) - attempt ${verifyData.fixAttempts}/${maxFixAttempts}`, outcome: 'red', blocked: false, fixAttempts: verifyData.fixAttempts, maxFixAttempts, testResults };
}

function fail(message: string, maxFixAttempts: number): RecordVerificationResult {
  return { ok: false, message, outcome: 'red', blocked: false, fixAttempts: 0, maxFixAttempts };
}

export interface RecordJudgeArgs {
  projectPath: string;
  specName: string;
  taskId: string;
  engine: string;                          // judging engine (opposite family of the implementer)
  verdict: 'pass' | 'fail' | 'skipped';
  reasons?: string;
  judgeMaxAttempts?: number;               // reopen rounds before blocking (default 2)
}

export interface RecordJudgeResult {
  ok: boolean;
  message: string;
  outcome: 'pass' | 'reopened' | 'blocked' | 'skipped' | 'error';
  attempts: number;
}

/**
 * L2 adequacy judge verdict. Runs AFTER a harness-green verdict and can only DOWNGRADE it:
 * - pass    → task stays [x], stamp judge.
 * - fail    → reopen the task to [ ] (so the loop re-picks it) and bump a PERSISTENT attempts
 *             counter; at judgeMaxAttempts → block [~]. Never touches a red/blocked task.
 * - skipped → record provenance only (e.g. opposite engine unavailable); task untouched.
 */
export async function recordJudgeVerdict(args: RecordJudgeArgs): Promise<RecordJudgeResult> {
  const { projectPath, specName, taskId, engine, verdict, reasons } = args;
  const judgeMaxAttempts = args.judgeMaxAttempts ?? 2;

  if (!/^\d+(\.\d+)*$/.test(taskId)) {
    return { ok: false, message: `Invalid taskId format: '${taskId}'`, outcome: 'error', attempts: 0 };
  }

  const specPath = PathUtils.getSpecPath(projectPath, specName);
  const tasksFile = join(specPath, 'tasks.md');

  let tasksContent: string;
  try {
    tasksContent = await fs.readFile(tasksFile, 'utf-8');
  } catch {
    return { ok: false, message: `Tasks file not found for spec '${specName}'`, outcome: 'error', attempts: 0 };
  }

  const { file: verifyFile, data: verifyData } = await openVerifyResult(specPath, specName, taskId);

  // attempts persists across the reopen (NOT reset with the harness fixAttempts), else it never caps.
  const prevAttempts = verifyData.judge?.attempts ?? 0;
  const timestamp = new Date().toISOString();

  if (verdict === 'pass' || verdict === 'skipped') {
    verifyData.judge = { engine, verdict, reasons, attempts: prevAttempts, timestamp };
    await saveVerifyResult(verifyFile, verifyData);
    return { ok: true, message: `Task '${taskId}' judge ${verdict} (${engine})`, outcome: verdict, attempts: prevAttempts };
  }

  // fail
  const attempts = prevAttempts + 1;
  if (attempts >= judgeMaxAttempts) {
    const reason = `adequacy not met after ${attempts} judge rounds — ${reasons || 'needs human'}`;
    await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, 'blocked', reason), 'utf-8');
    verifyData.judge = { engine, verdict: 'fail', reasons, attempts, timestamp };
    await saveVerifyResult(verifyFile, verifyData);
    return { ok: true, message: `Task '${taskId}' BLOCKED — ${reason}`, outcome: 'blocked', attempts };
  }
  // reopen to pending so the loop re-picks and strengthens the tests. The harness fix counter
  // restarts for the new round (judge.attempts is the bounded counter here, not fixAttempts) —
  // otherwise a reopened task that goes red once is blocked immediately.
  await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, 'pending'), 'utf-8');
  verifyData.fixAttempts = 0;
  verifyData.judge = { engine, verdict: 'fail', reasons, attempts, timestamp };
  await saveVerifyResult(verifyFile, verifyData);
  return { ok: true, message: `Task '${taskId}' judge FAIL (${engine}) — reopened, attempt ${attempts}/${judgeMaxAttempts}`, outcome: 'reopened', attempts };
}

interface UsageEntry {
  specName: string; taskId: string; taskName: string; engine: string; signal: string; timestamp: string;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number } | null;
}

function usageEntry(specName: string, taskId: string, taskName: string, engine: string | undefined, signal: string, timestamp: string, usage: UsageEntry['usage'] | undefined): UsageEntry {
  return { specName, taskId, taskName, engine: engine || ENGINE_DEFAULTS.default, signal, timestamp, usage: usage || null };
}

async function appendUsageLog(projectPath: string, entry: UsageEntry): Promise<void> {
  try {
    const logFile = join(PathUtils.getWorkflowRoot(projectPath), 'usage-log.json');
    let log: { entries: UsageEntry[] } = { entries: [] };
    try { log = JSON.parse(await fs.readFile(logFile, 'utf-8')); } catch { /* first write */ }
    log.entries.push(entry);
    await fs.writeFile(logFile, JSON.stringify(log, null, 2), 'utf-8');
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------------------------
// Manual task-state transitions (Telegram /task buttons, `spec-workflow-mcp reset`, humans).
// Kept here so verify-core stays the SOLE writer of task state. Refused while the loop runner
// owns the spec (its .run/pid is alive) — the harness must never race a human edit.
// ---------------------------------------------------------------------------------------------

export type ManualTaskStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';

export interface SetTaskStatusArgs {
  projectPath: string;
  specName: string;
  taskId: string;
  status: ManualTaskStatus;
  /** Required when status === 'blocked'. */
  reason?: string;
  /** Who did it (telegram user id, 'cli', ...). Recorded in verify-results.manual. */
  by: string;
  /** Skip the loop-running guard (only for the runner itself / tests). */
  force?: boolean;
}

export interface SetTaskStatusResult {
  ok: boolean;
  message: string;
  previous?: ManualTaskStatus;
}

export async function setTaskStatus(args: SetTaskStatusArgs): Promise<SetTaskStatusResult> {
  const { projectPath, specName, taskId, status, reason, by, force } = args;
  if (!/^\d+(\.\d+)*$/.test(taskId)) {
    return { ok: false, message: `Invalid taskId format: '${taskId}'` };
  }
  if (status === 'blocked' && !reason?.trim()) {
    return { ok: false, message: 'A reason is required to block a task' };
  }

  if (!force) {
    const { getLoopStatus } = await import('./run-state.js');
    const loop = await getLoopStatus(projectPath, specName);
    if (loop.running) {
      return { ok: false, message: `Loop is running for '${specName}' (pid ${loop.pid}); stop it first (/stop) before changing task state by hand` };
    }
  }

  const specPath = PathUtils.getSpecPath(projectPath, specName);
  const tasksFile = join(specPath, 'tasks.md');
  let tasksContent: string;
  try {
    tasksContent = await fs.readFile(tasksFile, 'utf-8');
  } catch {
    return { ok: false, message: `Tasks file not found for spec '${specName}'` };
  }
  const task = getTaskById(parseTasksFromMarkdown(tasksContent).tasks, taskId);
  if (!task) return { ok: false, message: `Task '${taskId}' not found in spec '${specName}'` };
  const previous = task.status as ManualTaskStatus;

  await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, status, reason), 'utf-8');

  // Journal the manual transition next to the harness verdicts (never overwrite them).
  try {
    const { file: verifyFile, data: verifyData } = await openVerifyResult(specPath, specName, taskId);
    if (status === 'pending') verifyData.fixAttempts = 0; // same recovery semantics as the old kanban drag-back
    verifyData.manual = { by, from: previous, to: status, reason, timestamp: new Date().toISOString() };
    await saveVerifyResult(verifyFile, verifyData);
  } catch { /* non-critical */ }

  return { ok: true, message: `Task '${taskId}' ${previous} → ${status} (by ${by})`, previous };
}
