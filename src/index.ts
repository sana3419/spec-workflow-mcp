#!/usr/bin/env node

import { SpecWorkflowMCPServer } from './server.js';
import { homedir } from 'os';
import { resolveGitRoot, resolveGitWorkspaceRoot } from './core/git-utils.js';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';

function showHelp() {
  console.error(`
Spec Workflow MCP Server - spec-driven development with harness-owned verification

USAGE:
  spec-workflow-mcp [path] [options]
  spec-workflow-mcp <subcommand> ...

ARGUMENTS:
  path                    Project path (defaults to current directory). Supports ~.

OPTIONS:
  --help                  Show this help message
  --telegram              Run the Telegram loop_bot daemon (ONE per machine, no MCP server).
                          Config: ~/.spec-workflow/telegram.env
                            TELEGRAM_BOT_TOKEN=...      TELEGRAM_ALLOW_FROM=<numeric user ids>
                            [TELEGRAM_NOTIFY=...] [TELEGRAM_PROJECTS=/abs/a,/abs/b] [TELEGRAM_SEND_ONLY=true]
  --telegram-once         One watcher tick (push events, post gate cards) then exit — for cron.
  --no-shared-worktree-specs
                          Disable shared .spec-workflow in git worktrees

SUBCOMMANDS (humans & the loop runner — the harness owns task state):
  status [spec] [--project p]                       progress + loop state (JSON)
  stop <spec> [--by who] [--project p]              ask a running loop to stop
  reset <spec> --task <id> [--project p]            task → pending (refused while loop runs)
  set-status <spec> --task <id> --status <s> [--reason r] [--force]
  cleanup --older-than <days> [--archived] [--yes]  delete old specs (dry-run without --yes)
  pick | verify | scopes | judge-record             used by spec-loop-run.sh

MODES:
  1. MCP server (default):      spec-workflow-mcp ~/my-project
  2. Telegram daemon (global):  spec-workflow-mcp --telegram
     Every project whose MCP server has registered (or listed in TELEGRAM_PROJECTS)
     is watched; loop progress, gates and commands go through the bot.
`);
}

function expandTildePath(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return path.replace('~', homedir());
  }
  return path;
}

export function parseArguments(args: string[]): {
  workspacePath: string;
  workflowRootPath: string;
  expandedPath: string;
  isTelegramMode: boolean;
  noSharedWorktreeSpecs: boolean;
  lang?: string;
} {
  const isTelegramMode = args.includes('--telegram') || args.includes('--telegram-once');
  const noSharedWorktreeSpecs = args.includes('--no-shared-worktree-specs');

  const validFlags = ['--telegram', '--telegram-once', '--help', '-h', '--no-shared-worktree-specs'];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const flagName = arg.includes('=') ? arg.split('=')[0] : arg;
      if (!validFlags.includes(flagName)) {
        throw new Error(`Unknown option: ${flagName}\nUse --help to see available options.`);
      }
    }
  }

  const filteredArgs = args.filter(arg => !arg.startsWith('--'));
  const rawProjectPath = filteredArgs[0] || process.cwd();
  const expandedPath = expandTildePath(rawProjectPath);
  const workspacePath = resolveGitWorkspaceRoot(expandedPath);
  const workflowRootPath = noSharedWorktreeSpecs ? workspacePath : resolveGitRoot(workspacePath);

  if (!filteredArgs[0] && !isTelegramMode) {
    console.warn(`Warning: No project path specified, using current directory: ${workspacePath}`);
    console.warn('Consider specifying an explicit path for better clarity.');
  }

  return { workspacePath, workflowRootPath, expandedPath, isTelegramMode, noSharedWorktreeSpecs, lang: undefined };
}

async function main() {
  try {
    const args = process.argv.slice(2);

    // Harness CLI subcommands (pick/verify/stop/status/...) used by the loop runner and humans.
    // These run and exit before any server logic.
    const { runSubcommand } = await import('./cli.js');
    const subResult = await runSubcommand(args);
    if (subResult !== null) {
      process.exit(subResult);
    }

    // Telegram loop_bot daemon (global, one per machine). Replaces the web dashboard.
    if (args.includes('--telegram') || args.includes('--telegram-once')) {
      const { runTelegramDaemon } = await import('./telegram/daemon.js');
      await runTelegramDaemon({ once: args.includes('--telegram-once') });
      process.exit(0);
    }

    // Check for help flag
    if (args.includes('--help') || args.includes('-h')) {
      showHelp();
      process.exit(0);
    }

    // Parse command-line arguments
    const cliArgs = parseArguments(args);
    const workspacePath = cliArgs.workspacePath;
    const workflowRootPath = cliArgs.workflowRootPath;
    const noSharedWorktreeSpecs = cliArgs.noSharedWorktreeSpecs;

    // Log worktree details when workspace and shared workflow roots differ
    if (workspacePath !== workflowRootPath) {
      console.error('Git worktree detected.');
      console.error(`workspacePath=${workspacePath}`);
      console.error(`workflowRootPath=${workflowRootPath}`);
    } else if (noSharedWorktreeSpecs) {
      console.error('Shared worktree specs disabled. Using workspace-local .spec-workflow.');
      console.error(`workspacePath=${workspacePath}`);
    }

    // MCP server mode
    console.error(`Starting Spec Workflow MCP Server for project: ${workflowRootPath}`);
    console.error(`Workspace path: ${workspacePath}`);
    console.error(`Working directory: ${process.cwd()}`);

    const server = new SpecWorkflowMCPServer();
    await server.initialize(workflowRootPath, workspacePath, cliArgs.lang);

    process.on('SIGINT', async () => { await server.stop(); process.exit(0); });
    process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });

  } catch (error: any) {
    console.error('Error:', error.message);

    // Provide additional context for common path-related issues
    if (error.message.includes('ENOENT') || error.message.includes('path') || error.message.includes('directory')) {
      console.error('\nProject path troubleshooting:');
      console.error('- Verify the project path exists and is accessible');
      console.error('- For Claude CLI users, ensure you used: claude mcp add spec-workflow npx -y spec-workflow-mcp@latest -- /path/to/your/project');
      console.error('- Check that the path doesn\'t contain special characters that need escaping');
      console.error(`- Current working directory: ${process.cwd()}`);
    }

    process.exit(1);
  }
}

export function resolveEntrypoint(pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;

  try {
    return realpathSync(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

const entrypoint = resolveEntrypoint(process.argv[1]);
const currentFile = resolveEntrypoint(fileURLToPath(import.meta.url));

if (entrypoint && currentFile && currentFile === entrypoint) {
  main().catch(() => process.exit(1));
}
