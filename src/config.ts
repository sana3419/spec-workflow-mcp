import * as fs from 'fs';
import * as path from 'path';
import * as toml from 'toml';
import { homedir } from 'os';
import { isLocalhostAddress } from './core/security-utils.js';

export interface SpecWorkflowConfig {
  projectDir?: string;
  port?: number;
  bindAddress?: string; // IP address to bind to (e.g., '127.0.0.1', '0.0.0.0')
  allowExternalAccess?: boolean; // Explicit opt-in for non-localhost binding
  dashboardOnly?: boolean;
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
    coverageMin?: number;    // Optional L1 coverage non-regression floor (0-100); enforced only if set
    // L2 cross-family adequacy judge: after harness-green, an opposite-engine judge checks whether
    // the agent-authored tests are adequate (not trivial). Opt-in; recommended. Can only reopen a green.
    judge?: boolean;
    judgeMaxAttempts?: number; // judge-fail reopen rounds before blocking (default 2)
    // L4 integration terminal gate: once the spec is DONE, prove the ASSEMBLED system builds + boots
    // (the real tsc/build L0 skips per-task). Opt-in. On failure: bounded auto-fix, then report.
    integrationCommand?: string;
    integrationFixAttempts?: number; // bounded auto-fix rounds on integration failure (default 1)
    integrationJudge?: boolean;      // opt-in cross-module LLM review after a green integration
  };

  // Security features
  security?: {
    rateLimitEnabled?: boolean;
    rateLimitPerMinute?: number;
    auditLogEnabled?: boolean;
    auditLogPath?: string;
    auditLogRetentionDays?: number;
    corsEnabled?: boolean;
    allowedOrigins?: string[];
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

function validatePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function validateConfig(config: any): { valid: boolean; error?: string } {
  if (config.port !== undefined) {
    if (!validatePort(config.port)) {
      return { 
        valid: false, 
        error: `Invalid port: ${config.port}. Port must be between 1024 and 65535.` 
      };
    }
  }

  if (config.projectDir !== undefined && typeof config.projectDir !== 'string') {
    return {
      valid: false,
      error: `Invalid projectDir: must be a string.`
    };
  }

  if (config.dashboardOnly !== undefined && typeof config.dashboardOnly !== 'boolean') {
    return { 
      valid: false, 
      error: `Invalid dashboardOnly: must be a boolean.` 
    };
  }

  if (config.lang !== undefined && typeof config.lang !== 'string') {
    return { 
      valid: false, 
      error: `Invalid lang: must be a string.` 
    };
  }

  // Validate network configuration
  if (config.bindAddress !== undefined && typeof config.bindAddress !== 'string') {
    return {
      valid: false,
      error: `Invalid bindAddress: must be a valid IP address string.`
    };
  }

  if (config.allowExternalAccess !== undefined && typeof config.allowExternalAccess !== 'boolean') {
    return {
      valid: false,
      error: `Invalid allowExternalAccess: must be a boolean.`
    };
  }

  // Network security validation: if binding to non-localhost address, require explicit allowExternalAccess
  if (config.bindAddress !== undefined && !isLocalhostAddress(config.bindAddress) && !config.allowExternalAccess) {
    return {
      valid: false,
      error: `Network security: binding to '${config.bindAddress}' (non-localhost) requires explicit allowExternalAccess = true. This exposes your dashboard to network access.`
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
    if (lp.coverageMin !== undefined && (typeof lp.coverageMin !== 'number' || lp.coverageMin < 0 || lp.coverageMin > 100)) {
      return { valid: false, error: `Invalid loop.coverageMin: must be a number between 0 and 100.` };
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
  }

  // Validate security features
  if (config.security !== undefined) {
    const sec = config.security;

    if (sec.rateLimitPerMinute !== undefined && (typeof sec.rateLimitPerMinute !== 'number' || sec.rateLimitPerMinute < 1)) {
      return {
        valid: false,
        error: `Invalid security.rateLimitPerMinute: must be a positive number.`
      };
    }

    if (sec.auditLogRetentionDays !== undefined && (typeof sec.auditLogRetentionDays !== 'number' || sec.auditLogRetentionDays < 1)) {
      return {
        valid: false,
        error: `Invalid security.auditLogRetentionDays: must be a positive number.`
      };
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
    
    if (parsedConfig.port !== undefined) {
      config.port = parsedConfig.port;
    }

    if (parsedConfig.bindAddress !== undefined) {
      config.bindAddress = parsedConfig.bindAddress;
    }

    if (parsedConfig.allowExternalAccess !== undefined) {
      config.allowExternalAccess = parsedConfig.allowExternalAccess;
    }

    if (parsedConfig.dashboardOnly !== undefined) {
      config.dashboardOnly = parsedConfig.dashboardOnly;
    }
    
    if (parsedConfig.lang !== undefined) {
      config.lang = parsedConfig.lang;
    }

    if (parsedConfig.security !== undefined) {
      config.security = parsedConfig.security;
    }

    if (parsedConfig.engine !== undefined) {
      config.engine = {
        default: parsedConfig.engine.default || 'claude',
        maxFixAttempts: parsedConfig.engine.maxFixAttempts || 5,
        codex: {
          model: parsedConfig.engine.codex?.model,
          sandbox: parsedConfig.engine.codex?.sandbox || 'workspace-write',
          approvalPolicy: parsedConfig.engine.codex?.approvalPolicy || 'never',
        },
      };
    }

    if (parsedConfig.loop !== undefined) {
      config.loop = {
        autoLoop: parsedConfig.loop.autoLoop ?? false,
        maxIterations: parsedConfig.loop.maxIterations || 50,
        noProgressStop: parsedConfig.loop.noProgressStop || 3,
        ...(parsedConfig.loop.testCommand !== undefined && { testCommand: parsedConfig.loop.testCommand }),
        ...(parsedConfig.loop.coverageMin !== undefined && { coverageMin: parsedConfig.loop.coverageMin }),
        ...(parsedConfig.loop.judge !== undefined && { judge: parsedConfig.loop.judge }),
        ...(parsedConfig.loop.judgeMaxAttempts !== undefined && { judgeMaxAttempts: parsedConfig.loop.judgeMaxAttempts }),
        ...(parsedConfig.loop.integrationCommand !== undefined && { integrationCommand: parsedConfig.loop.integrationCommand }),
        ...(parsedConfig.loop.integrationFixAttempts !== undefined && { integrationFixAttempts: parsedConfig.loop.integrationFixAttempts }),
        ...(parsedConfig.loop.integrationJudge !== undefined && { integrationJudge: parsedConfig.loop.integrationJudge }),
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