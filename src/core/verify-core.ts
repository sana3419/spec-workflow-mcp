import { promises as fs } from 'fs';
import { join } from 'path';
import { PathUtils } from './path-utils.js';
import { parseTasksFromMarkdown, getTaskById, updateTaskStatus } from './task-parser.js';
import { VerifyResult } from '../types.js';

export type VerifySignal = 'green' | 'red' | 'blocked';
export type VerifySource = 'harness-exec' | 'agent' | 'none';

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
export async function recordVerification(args: RecordVerificationArgs): Promise<RecordVerificationResult> {
  const {
    projectPath, specName, taskId, signal, source,
    testResults = [], fixNote, engine, exitCode, testScope, tamperGateOff, usage,
  } = args;
  const maxFixAttempts = args.maxFixAttempts ?? 5;

  if (!/^\d+(\.\d+)*$/.test(taskId)) {
    return fail(`Invalid taskId format: '${taskId}'. Must be digits and dots (e.g., '1', '1.1').`, maxFixAttempts);
  }
  if (signal === 'red' && (!testResults || testResults.length === 0)) {
    return fail('testResults is required when signal is red', maxFixAttempts);
  }

  const translatedPath = PathUtils.translatePath(projectPath);
  const specPath = PathUtils.getSpecPath(translatedPath, specName);
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

  const verifyDir = join(specPath, 'verify-results');
  await fs.mkdir(verifyDir, { recursive: true });
  const verifyFile = join(verifyDir, `task-${taskId.replace(/\./g, '-')}.json`);

  let verifyData: VerifyResult;
  try {
    verifyData = JSON.parse(await fs.readFile(verifyFile, 'utf-8'));
  } catch {
    verifyData = { taskId, specName, fixAttempts: 0, lastSignal: null, lastTestResults: [], lastFixNote: '', lastTimestamp: '' };
  }

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
  };

  if (signal === 'green') {
    await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, 'completed'), 'utf-8');
    verifyData.lastSignal = 'green';
    stamp();
    await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');
    await appendUsageLog(projectPath, usageEntry(specName, taskId, task.description, effEngine, 'green', verifyData.lastTimestamp, usage));
    return { ok: true, message: `Task '${taskId}' verified GREEN (${source}) - marked completed`, outcome: 'green', blocked: false, fixAttempts: verifyData.fixAttempts, maxFixAttempts };
  }

  if (signal === 'blocked') {
    // Direct block (tamper gate / agent-reported blocker) — does not consume fix attempts.
    const reason = fixNote || 'Blocked - manual intervention required';
    await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, 'blocked', reason), 'utf-8');
    verifyData.lastSignal = 'red';
    stamp();
    await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');
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
    await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');
    await appendUsageLog(projectPath, usageEntry(specName, taskId, task.description, effEngine, 'blocked', verifyData.lastTimestamp, usage));
    return { ok: true, message: `Task '${taskId}' BLOCKED after ${verifyData.fixAttempts} failed attempts`, outcome: 'blocked', blocked: true, fixAttempts: verifyData.fixAttempts, maxFixAttempts };
  }
  await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');
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

  const translatedPath = PathUtils.translatePath(projectPath);
  const specPath = PathUtils.getSpecPath(translatedPath, specName);
  const tasksFile = join(specPath, 'tasks.md');

  let tasksContent: string;
  try {
    tasksContent = await fs.readFile(tasksFile, 'utf-8');
  } catch {
    return { ok: false, message: `Tasks file not found for spec '${specName}'`, outcome: 'error', attempts: 0 };
  }

  const verifyDir = join(specPath, 'verify-results');
  await fs.mkdir(verifyDir, { recursive: true });
  const verifyFile = join(verifyDir, `task-${taskId.replace(/\./g, '-')}.json`);

  let verifyData: VerifyResult;
  try {
    verifyData = JSON.parse(await fs.readFile(verifyFile, 'utf-8'));
  } catch {
    verifyData = { taskId, specName, fixAttempts: 0, lastSignal: null, lastTestResults: [], lastFixNote: '', lastTimestamp: '' };
  }

  // attempts persists across the reopen (NOT reset with the harness fixAttempts), else it never caps.
  const prevAttempts = verifyData.judge?.attempts ?? 0;
  const timestamp = new Date().toISOString();

  if (verdict === 'pass' || verdict === 'skipped') {
    verifyData.judge = { engine, verdict, reasons, attempts: prevAttempts, timestamp };
    await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');
    return { ok: true, message: `Task '${taskId}' judge ${verdict} (${engine})`, outcome: verdict, attempts: prevAttempts };
  }

  // fail
  const attempts = prevAttempts + 1;
  if (attempts >= judgeMaxAttempts) {
    const reason = `adequacy not met after ${attempts} judge rounds — ${reasons || 'needs human'}`;
    await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, 'blocked', reason), 'utf-8');
    verifyData.judge = { engine, verdict: 'fail', reasons, attempts, timestamp };
    await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');
    return { ok: true, message: `Task '${taskId}' BLOCKED — ${reason}`, outcome: 'blocked', attempts };
  }
  // reopen to pending so the loop re-picks and strengthens the tests
  await fs.writeFile(tasksFile, updateTaskStatus(tasksContent, taskId, 'pending'), 'utf-8');
  verifyData.judge = { engine, verdict: 'fail', reasons, attempts, timestamp };
  await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');
  return { ok: true, message: `Task '${taskId}' judge FAIL (${engine}) — reopened, attempt ${attempts}/${judgeMaxAttempts}`, outcome: 'reopened', attempts };
}

interface UsageEntry {
  specName: string; taskId: string; taskName: string; engine: string; signal: string; timestamp: string;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number } | null;
}

function usageEntry(specName: string, taskId: string, taskName: string, engine: string | undefined, signal: string, timestamp: string, usage: UsageEntry['usage'] | undefined): UsageEntry {
  return { specName, taskId, taskName, engine: engine || 'claude', signal, timestamp, usage: usage || null };
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
