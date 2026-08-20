import * as fs from 'fs';
import * as path from 'path';
import * as toml from 'toml';
import { homedir } from 'os';

export interface SpecWorkflowConfig {
  projectDir?: string;
  lang?: string;

  // Engine configuration for Codex dispatch
  engine?: {
    default?: string;        // Default engine: 'codex' or 'claude'
    maxFixAttempts?: number; // Max fix attempts before blocking task
    codex?: {
      model?: string;          // Optional Codex model override (omit to use Codex default)
      sandbox?: string;        // 'read-only' | 'workspace-write' | 'danger-full-access'
      approvalPolicy?: string; // 'untrusted' | 'on-failure' | 'on-request' | 'never'
    };
  };

  // Phase 4 background loop runner config (.spec-workflow/spec-loop-run.sh)
  loop?: {
    autoLoop?: boolean;      // master on/off for the background loop runner
    maxIterations?: number;  // Hard cap on loop iterations (primary safety stop)
    noProgressStop?: number; // Stop after N consecutive iterations with no tasks.md change
    // L0 harness verdict: command template with a {tests} slot the loop runs to derive green/red
    // from the exit code (e.g. "npm test -- {tests}"). When unset, the loop falls back to the
    // DEPRECATED agent-self-report path. Per-task scope comes from each task's _Tests: tag.
    testCommand?: string;
    // L2 cross-family adequacy judge: after harness-green, an opposite-engine judge checks whether
    // the agent-authored tests are adequate (not trivial). Opt-in; recommended. Can only reopen a green.
    judge?: boolean;
    judgeMaxAttempts?: number; // judge-fail reopen rounds before blocking (default 2)
    // L4 integration terminal gate: once the spec is DONE, prove the ASSEMBLED system builds + boots
    // (the real tsc/build L0 skips per-task). Opt-in. On failure: bounded auto-fix, then report.
    integrationCommand?: string;
    integrationFixAttempts?: number; // bounded auto-fix rounds on integration failure (default 1)
    integrationJudge?: boolean;      // opt-in cross-module LLM review after a green integration
    // L3 spec gate: before implementing, a cross-family auditor critiques the spec for hackable
    // ambiguity; if it would let wrong-but-green outcomes through, the loop refuses to start. Opt-in.
    specGate?: boolean;
    // Remote approval gates (Telegram). The runner pauses and asks a human; the decision is HMAC-signed
    // and stored outside the project. Read by templates/spec-loop-run.sh; declared here so the type is
    // an honest model of [loop]. Timeout or reject = stop.
    gateOnSpecGateFail?: boolean;    // spec gate failed → approve = override-and-proceed (audited)
    gateOnIntegrationFail?: boolean; // integration failed → approve = one more bounded fix round
    gateEveryTasks?: number;         // >0: pause for a human checkpoint after every N green tasks (0 = off)
    gateTimeoutMin?: number;         // minutes to wait for a decision before treating it as reject
  };

  // Security features
}

/** The one place engine defaults live. Every consumer (server context, spec-status hints, CLI) uses this. */
export const ENGINE_DEFAULTS = { default: 'claude', maxFixAttempts: 5, codex: { sandbox: 'workspace-write', approvalPolicy: 'never' } } as const;

export function resolveEngineConfig(eng?: SpecWorkflowConfig['engine']): Required<Pick<NonNullable<SpecWorkflowConfig['engine']>, 'default' | 'maxFixAttempts'>> & { codex: { model?: string; sandbox: string; approvalPolicy: string } } {
  return {
    default: eng?.default || ENGINE_DEFAULTS.default,
    maxFixAttempts: eng?.maxFixAttempts || ENGINE_DEFAULTS.maxFixAttempts,
    codex: {
      model: eng?.codex?.model,
      sandbox: eng?.codex?.sandbox || ENGINE_DEFAULTS.codex.sandbox,
      approvalPolicy: eng?.codex?.approvalPolicy || ENGINE_DEFAULTS.codex.approvalPolicy,
    },
  };
}

export interface ConfigLoadResult {
  config: SpecWorkflowConfig | null;
  configPath: string | null;
  error?: string;
}

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~')) {
    return path.join(homedir(), filepath.slice(1));
  }
  return filepath;
}

function validateConfig(config: any): { valid: boolean; error?: string } {
  if (config.projectDir !== undefined && typeof config.projectDir !== 'string') {
    return {
      valid: false,
      error: `Invalid projectDir: must be a string.`
    };
  }

  if (config.lang !== undefined && typeof config.lang !== 'string') {
    return { 
      valid: false, 
      error: `Invalid lang: must be a string.` 
    };
  }

  // Validate engine configuration
  if (config.engine !== undefined) {
    const eng = config.engine;
    if (eng.default !== undefined) {
      const validEngines = ['codex', 'claude'];
      if (typeof eng.default !== 'string' || !validEngines.includes(eng.default)) {
        return { valid: false, error: `Invalid engine.default: must be one of ${validEngines.join(', ')}.` };
      }
    }
    if (eng.maxFixAttempts !== undefined && (typeof eng.maxFixAttempts !== 'number' || eng.maxFixAttempts < 1)) {
      return { valid: false, error: `Invalid engine.maxFixAttempts: must be a positive number.` };
    }
    if (eng.codex !== undefined) {
      const cx = eng.codex;
      if (cx.model !== undefined && typeof cx.model !== 'string') {
        return { valid: false, error: `Invalid engine.codex.model: must be a string.` };
      }
      const validSandbox = ['read-only', 'workspace-write', 'danger-full-access'];
      if (cx.sandbox !== undefined && (typeof cx.sandbox !== 'string' || !validSandbox.includes(cx.sandbox))) {
        return { valid: false, error: `Invalid engine.codex.sandbox: must be one of ${validSandbox.join(', ')}.` };
      }
      const validApproval = ['untrusted', 'on-failure', 'on-request', 'never'];
      if (cx.approvalPolicy !== undefined && (typeof cx.approvalPolicy !== 'string' || !validApproval.includes(cx.approvalPolicy))) {
        return { valid: false, error: `Invalid engine.codex.approvalPolicy: must be one of ${validApproval.join(', ')}.` };
      }
    }
  }

  // Validate loop configuration
  if (config.loop !== undefined) {
    const lp = config.loop;
    if (lp.autoLoop !== undefined && typeof lp.autoLoop !== 'boolean') {
      return { valid: false, error: `Invalid loop.autoLoop: must be a boolean.` };
    }
    if (lp.maxIterations !== undefined && (typeof lp.maxIterations !== 'number' || lp.maxIterations < 1)) {
      return { valid: false, error: `Invalid loop.maxIterations: must be a positive number.` };
    }
    if (lp.noProgressStop !== undefined && (typeof lp.noProgressStop !== 'number' || lp.noProgressStop < 1)) {
      return { valid: false, error: `Invalid loop.noProgressStop: must be a positive number.` };
    }
    if (lp.testCommand !== undefined && typeof lp.testCommand !== 'string') {
      return { valid: false, error: `Invalid loop.testCommand: must be a string (e.g. "npm test -- {tests}").` };
    }
    if (lp.judge !== undefined && typeof lp.judge !== 'boolean') {
      return { valid: false, error: `Invalid loop.judge: must be a boolean.` };
    }
    if (lp.judgeMaxAttempts !== undefined && (typeof lp.judgeMaxAttempts !== 'number' || lp.judgeMaxAttempts < 1)) {
      return { valid: false, error: `Invalid loop.judgeMaxAttempts: must be a positive number.` };
    }
    if (lp.integrationCommand !== undefined && typeof lp.integrationCommand !== 'string') {
      return { valid: false, error: `Invalid loop.integrationCommand: must be a string.` };
    }
    if (lp.integrationFixAttempts !== undefined && (typeof lp.integrationFixAttempts !== 'number' || lp.integrationFixAttempts < 0)) {
      return { valid: false, error: `Invalid loop.integrationFixAttempts: must be a non-negative number.` };
    }
    if (lp.integrationJudge !== undefined && typeof lp.integrationJudge !== 'boolean') {
      return { valid: false, error: `Invalid loop.integrationJudge: must be a boolean.` };
    }
    if (lp.specGate !== undefined && typeof lp.specGate !== 'boolean') {
      return { valid: false, error: `Invalid loop.specGate: must be a boolean.` };
    }
    if (lp.gateOnSpecGateFail !== undefined && typeof lp.gateOnSpecGateFail !== 'boolean') {
      return { valid: false, error: `Invalid loop.gateOnSpecGateFail: must be a boolean.` };
    }
    if (lp.gateOnIntegrationFail !== undefined && typeof lp.gateOnIntegrationFail !== 'boolean') {
      return { valid: false, error: `Invalid loop.gateOnIntegrationFail: must be a boolean.` };
    }
    if (lp.gateEveryTasks !== undefined && (typeof lp.gateEveryTasks !== 'number' || lp.gateEveryTasks < 0)) {
      return { valid: false, error: `Invalid loop.gateEveryTasks: must be a non-negative number (0 disables it).` };
    }
    if (lp.gateTimeoutMin !== undefined && (typeof lp.gateTimeoutMin !== 'number' || lp.gateTimeoutMin < 1)) {
      return { valid: false, error: `Invalid loop.gateTimeoutMin: must be a positive number of minutes.` };
    }
  }

  return { valid: true };
}

export function loadConfigFromPath(configPath: string): ConfigLoadResult {
  try {
    const expandedPath = expandTilde(configPath);
    
    if (!fs.existsSync(expandedPath)) {
      return { 
        config: null, 
        configPath: expandedPath,
        error: `Config file not found: ${expandedPath}`
      };
    }

    const configContent = fs.readFileSync(expandedPath, 'utf-8');
    const parsedConfig = toml.parse(configContent);

    const validation = validateConfig(parsedConfig);
    if (!validation.valid) {
      return { 
        config: null, 
        configPath: expandedPath, 
        error: validation.error 
      };
    }

    const config: SpecWorkflowConfig = {};
    
    if (parsedConfig.projectDir !== undefined) {
      config.projectDir = expandTilde(parsedConfig.projectDir);
    }
    
    
    if (parsedConfig.lang !== undefined) {
      config.lang = parsedConfig.lang;
    }

    // [engine] is ALWAYS filled (defaults applied here, once) so consumers never re-derive them.
    config.engine = resolveEngineConfig(parsedConfig.engine);

    if (parsedConfig.loop !== undefined) {
      config.loop = {
        autoLoop: parsedConfig.loop.autoLoop ?? false,
        maxIterations: parsedConfig.loop.maxIterations || 50,
        noProgressStop: parsedConfig.loop.noProgressStop || 3,
        ...(parsedConfig.loop.testCommand !== undefined && { testCommand: parsedConfig.loop.testCommand }),
        ...(parsedConfig.loop.judge !== undefined && { judge: parsedConfig.loop.judge }),
        ...(parsedConfig.loop.judgeMaxAttempts !== undefined && { judgeMaxAttempts: parsedConfig.loop.judgeMaxAttempts }),
        ...(parsedConfig.loop.integrationCommand !== undefined && { integrationCommand: parsedConfig.loop.integrationCommand }),
        ...(parsedConfig.loop.integrationFixAttempts !== undefined && { integrationFixAttempts: parsedConfig.loop.integrationFixAttempts }),
        ...(parsedConfig.loop.integrationJudge !== undefined && { integrationJudge: parsedConfig.loop.integrationJudge }),
        ...(parsedConfig.loop.specGate !== undefined && { specGate: parsedConfig.loop.specGate }),
        ...(parsedConfig.loop.gateOnSpecGateFail !== undefined && { gateOnSpecGateFail: parsedConfig.loop.gateOnSpecGateFail }),
        ...(parsedConfig.loop.gateOnIntegrationFail !== undefined && { gateOnIntegrationFail: parsedConfig.loop.gateOnIntegrationFail }),
        ...(parsedConfig.loop.gateEveryTasks !== undefined && { gateEveryTasks: parsedConfig.loop.gateEveryTasks }),
        ...(parsedConfig.loop.gateTimeoutMin !== undefined && { gateTimeoutMin: parsedConfig.loop.gateTimeoutMin }),
      };
    }

    return { 
      config, 
      configPath: expandedPath 
    };
  } catch (error) {
    if (error instanceof Error) {
      return { 
        config: null, 
        configPath: null, 
        error: `Failed to load config file: ${error.message}` 
      };
    }
    return { 
      config: null, 
      configPath: null, 
      error: 'Failed to load config file: Unknown error' 
    };
  }
}

export function loadConfigFile(projectDir: string, customConfigPath?: string): ConfigLoadResult {
  // If custom config path is provided, use it
  if (customConfigPath) {
    return loadConfigFromPath(customConfigPath);
  }
  
  // Otherwise, look for default config in project directory
  try {
    const expandedDir = expandTilde(projectDir);
    const configDir = path.join(expandedDir, '.spec-workflow');
    const configPath = path.join(configDir, 'config.toml');
    
    if (!fs.existsSync(configPath)) {
      return { 
        config: null, 
        configPath: null 
      };
    }
    
    return loadConfigFromPath(configPath);
  } catch (error) {
    if (error instanceof Error) {
      return { 
        config: null, 
        configPath: null, 
        error: `Failed to load config file: ${error.message}` 
      };
    }
    return { 
      config: null, 
      configPath: null, 
      error: 'Failed to load config file: Unknown error' 
    };
  }
}

export function mergeConfigs(
  fileConfig: SpecWorkflowConfig | null,
  cliArgs: Partial<SpecWorkflowConfig>
): SpecWorkflowConfig {
  const merged: SpecWorkflowConfig = {};

  if (fileConfig) {
    Object.assign(merged, fileConfig);
  }

  Object.keys(cliArgs).forEach(key => {
    const value = cliArgs[key as keyof SpecWorkflowConfig];
    if (value !== undefined) {
      (merged as any)[key] = value;
    }
  });

  return merged;
}