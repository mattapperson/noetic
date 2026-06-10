/**
 * Skill content processor.
 *
 * Processes skill instructions by executing inline shell commands
 * (lines starting with `!`) and replacing them with their output.
 *
 * Every command passes the shared Bash-tool preflight
 * (`preflightShellCommand`: command validation + mutation policy) before
 * execution; blocked commands render as failure comments instead of running.
 */

import type { ShellAdapter } from '@noetic-tools/core';
import type { MutationPolicy } from '../tools/mutation-policy.js';
import { preflightShellCommand } from '../tools/preflight.js';

//#region Constants

const COMMAND_TIMEOUT_S = 10;
const COMMAND_PATTERN = /^(\s*)!(.+)$/gm;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB max output per command

//#endregion

//#region Helpers

function formatOutput(output: string, indent: string): string {
  if (output === '') {
    return `${indent}(no output)`;
  }

  const lines = output.split('\n');
  if (lines.length === 1) {
    return `${indent}${output}`;
  }

  // Multi-line output: wrap in code block
  const indentedLines = lines.map((line) => `${indent}${line}`).join('\n');
  return `${indent}\`\`\`\n${indentedLines}\n${indent}\`\`\``;
}

function truncateOutput(
  stdout: string,
  stderr: string,
): {
  stdout: string;
  stderr: string;
} {
  const totalBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  if (totalBytes <= MAX_OUTPUT_BYTES) {
    return {
      stdout,
      stderr,
    };
  }
  throw new Error(`Command output exceeded ${MAX_OUTPUT_BYTES} bytes limit`);
}

//#endregion

//#region Public API

/** Arguments for `processSkillContent`. */
export interface ProcessSkillContentArgs {
  /** The raw skill instructions. */
  content: string;
  /** Working directory for command execution. */
  cwd: string;
  /** Shell adapter to execute commands through. */
  shell: ShellAdapter;
  /**
   * Mutation policy consulted for probably-mutating inline commands.
   * Command validation (banned/high-risk/interactive) always runs.
   */
  mutationPolicy?: MutationPolicy;
}

/**
 * When embedded-command execution is disabled (untrusted project-origin
 * content), leave the `!cmd` lines intact so the model can see the author's
 * intent, but tag them with a comment explaining why they did not run.
 */
export function neutralizeEmbeddedCommands(text: string): string {
  return text.replace(COMMAND_PATTERN, (_match, indent: string, rest: string) => {
    return `${indent}!${rest}\n${indent}<!-- project embedded command not executed; enable via config.trustProjectEmbeddedCommands -->`;
  });
}

/**
 * Process skill content by executing inline shell commands.
 *
 * Lines starting with `!` (after optional whitespace) are treated as shell commands.
 * Each command is preflighted through the shared Bash-tool pipeline
 * (`validateCommand` + mutation policy); blocked commands are replaced with a
 * failure comment (`blocked: <reason>`) — activation never throws. Allowed
 * commands are executed and their output replaces the line.
 *
 * @returns Processed content with command outputs
 */
export async function processSkillContent(args: ProcessSkillContentArgs): Promise<string> {
  const { content, cwd, shell, mutationPolicy } = args;
  const matches: Array<{
    full: string;
    indent: string;
    command: string;
  }> = [];

  // Collect all matches first
  COMMAND_PATTERN.lastIndex = 0;
  for (
    let match = COMMAND_PATTERN.exec(content);
    match !== null;
    match = COMMAND_PATTERN.exec(content)
  ) {
    matches.push({
      full: match[0],
      indent: match[1],
      command: match[2],
    });
  }

  if (matches.length === 0) {
    return content;
  }

  // Execute commands and collect results
  const results = await Promise.allSettled(
    matches.map(async ({ command }) => {
      const preflight = await preflightShellCommand(command, {
        cwd,
        mutationPolicy,
      });
      if (!preflight.ok) {
        throw new Error(`blocked: ${preflight.reason}`);
      }

      const result = await shell.exec(command, {
        cwd,
        timeout: COMMAND_TIMEOUT_S,
      });

      // null exitCode means the process was killed (e.g., timeout)
      if (result.exitCode === null) {
        throw new Error('Command was killed (timeout or signal)');
      }

      if (result.exitCode !== 0) {
        const errMsg = result.stderr.trim() || result.stdout.trim();
        throw new Error(`Command exited with code ${result.exitCode}: ${errMsg}`);
      }

      const trimmed = truncateOutput(result.stdout.trim(), result.stderr.trim());
      return trimmed;
    }),
  );

  // Replace matches with results (use split/join to avoid $ token interpretation)
  let processed = content;
  for (let i = 0; i < matches.length; i++) {
    const { full, indent, command } = matches[i];
    const result = results[i];

    let replacement: string;
    if (result.status === 'fulfilled') {
      const { stdout, stderr } = result.value;
      const output = stdout || stderr || '';
      replacement = formatOutput(output, indent);

      // Add stderr as warning if both exist
      if (stdout && stderr) {
        replacement += `\n${indent}<!-- warning: ${stderr} -->`;
      }
    } else {
      const errorMsg =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      replacement = `${indent}<!-- error executing \`${command}\`: ${errorMsg} -->`;
    }

    processed = processed.split(full).join(replacement);
  }

  return processed;
}

//#endregion
