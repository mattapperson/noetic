/**
 * Skill content processor.
 *
 * Processes skill instructions by executing inline shell commands
 * (lines starting with `!`) and replacing them with their output.
 */

import { spawn } from 'node:child_process';

//#region Constants

const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_PATTERN = /^(\s*)!(.+)$/gm;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB max output per command

//#endregion

//#region Helpers

function executeCommand(
  command: string,
  cwd: string,
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'sh',
      [
        '-c',
        command,
      ],
      {
        cwd,
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
        timeout: COMMAND_TIMEOUT_MS,
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;

    child.stdout.on('data', (data: Buffer) => {
      if (truncated) {
        return;
      }
      totalBytes += data.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        child.kill('SIGTERM');
        return;
      }
      stdout.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      if (truncated) {
        return;
      }
      totalBytes += data.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        child.kill('SIGTERM');
        return;
      }
      stderr.push(data);
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code, signal) => {
      const stdoutStr = Buffer.concat(stdout).toString('utf-8').trim();
      const stderrStr = Buffer.concat(stderr).toString('utf-8').trim();

      // Handle output truncation
      if (truncated) {
        reject(new Error(`Command output exceeded ${MAX_OUTPUT_BYTES} bytes limit`));
        return;
      }

      // Handle timeout (signal is SIGTERM when spawn's timeout kills the process)
      if (code === null && signal !== null) {
        reject(new Error(`Command timed out (signal: ${signal})`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Command exited with code ${code}: ${stderrStr || stdoutStr}`));
        return;
      }

      resolve({
        stdout: stdoutStr,
        stderr: stderrStr,
      });
    });
  });
}

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

//#endregion

//#region Public API

/**
 * Process skill content by executing inline shell commands.
 *
 * Lines starting with `!` (after optional whitespace) are treated as shell commands.
 * The command is executed and its output replaces the line.
 *
 * @param content - The raw skill instructions
 * @param cwd - Working directory for command execution
 * @returns Processed content with command outputs
 */
export async function processSkillContent(content: string, cwd: string): Promise<string> {
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
    matches.map(async ({ command }) => executeCommand(command, cwd)),
  );

  // Replace matches with results
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

    processed = processed.replace(full, replacement);
  }

  return processed;
}

//#endregion
