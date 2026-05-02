/**
 * `browser` tool — drive a real Chrome instance through `agent-browser`.
 *
 * Wraps the `agent-browser` CLI (https://github.com/vercel-labs/agent-browser),
 * a native Rust CLI that talks Chrome DevTools Protocol directly. The package
 * is bundled as a project dependency so the binary resolves from
 * `node_modules/.bin/agent-browser` — no global install required.
 *
 * The verification sub-agent uses this for frontend probes (navigate, snapshot
 * accessibility tree, click `@ref`-style elements, fill forms, screenshot,
 * wait for text). agent-browser persists a daemon between calls; the agent
 * should `close` (or trust auto-cleanup) at the end of a verification run.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ShellAdapter, Tool } from '@noetic/core';
import { getToolCwd, tool } from '@noetic/core';
import { z } from 'zod';
import { shellQuote } from './path-utils.js';
import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from './truncate.js';

//#region Schemas

const NavigateSchema = z.object({
  action: z.literal('navigate'),
  url: z.string().min(1).describe('URL to open. http(s) or file:// scheme.'),
});

const SnapshotSchema = z.object({
  action: z.literal('snapshot'),
});

const ScreenshotSchema = z.object({
  action: z.literal('screenshot'),
  path: z.string().min(1).optional().describe('Output path. Default: writes to stdout.'),
});

const ClickSchema = z.object({
  action: z.literal('click'),
  ref: z
    .string()
    .min(1)
    .describe('Element reference. Either an @ref from a prior snapshot or a CSS selector.'),
});

const FillSchema = z.object({
  action: z.literal('fill'),
  ref: z.string().min(1).describe('Form-field element reference (@ref or CSS selector).'),
  value: z.string().describe('Text to fill (clears existing content first).'),
});

const TypeSchema = z.object({
  action: z.literal('type'),
  text: z.string().describe('Text to type at the focused element using real keystrokes.'),
});

const KeySchema = z.object({
  action: z.literal('key'),
  key: z.string().min(1).describe('Key to press (e.g. "Enter", "Tab", "Control+a").'),
});

const WaitForSchema = z.object({
  action: z.literal('wait_for'),
  text: z
    .string()
    .min(1)
    .describe('Text or selector to wait for. If purely numeric, treated as a millisecond delay.'),
  timeoutMs: z.number().int().min(1).optional().describe('Total timeout in ms.'),
});

const EvalSchema = z.object({
  action: z.literal('eval'),
  js: z.string().min(1).describe('JavaScript expression to evaluate in the page.'),
});

const CloseSchema = z.object({
  action: z.literal('close'),
  all: z.boolean().optional().describe('Close every browser session, not just the current one.'),
});

const InternalInputSchema = z.discriminatedUnion('action', [
  NavigateSchema,
  SnapshotSchema,
  ScreenshotSchema,
  ClickSchema,
  FillSchema,
  TypeSchema,
  KeySchema,
  WaitForSchema,
  EvalSchema,
  CloseSchema,
]);

type InternalInput = z.infer<typeof InternalInputSchema>;

// Flat LLM-visible schema — every variant's fields appear as optional
// properties on a single object so `z.toJSONSchema` emits a top-level
// `{ type: "object", properties: {...} }`. Per-action required fields are
// re-validated through `InternalInputSchema` inside `execute`.
const BrowserInputSchema = z.object({
  action: z
    .enum([
      'navigate',
      'snapshot',
      'screenshot',
      'click',
      'fill',
      'type',
      'key',
      'wait_for',
      'eval',
      'close',
    ])
    .describe('Action to perform. Required fields vary by action — see field descriptions.'),
  url: z.string().min(1).optional().describe('navigate (required): URL to open.'),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe('click/fill (required): @ref from a prior snapshot or a CSS selector.'),
  value: z.string().optional().describe('fill (required): text to fill into the field.'),
  text: z
    .string()
    .optional()
    .describe(
      'type (required): text to type at the focused element. wait_for (required): text or selector to wait for (numeric values are interpreted as ms).',
    ),
  key: z.string().min(1).optional().describe('key (required): key to press (Enter, Tab, etc).'),
  path: z.string().min(1).optional().describe('screenshot (optional): output path.'),
  js: z.string().min(1).optional().describe('eval (required): JavaScript to evaluate.'),
  timeoutMs: z.number().int().min(1).optional().describe('wait_for (optional): timeout in ms.'),
  all: z
    .boolean()
    .optional()
    .describe('close (optional): close every browser session, not just the current one.'),
});

const BrowserOutputSchema = z.object({
  output: z.string().describe('agent-browser stdout (and stderr on failure).'),
  exitCode: z
    .number()
    .optional()
    .describe('Process exit code. Undefined if the binary could not be located.'),
  action: z.string().describe('The action that was attempted.'),
  truncated: z.boolean().describe('Whether the output was truncated.'),
});

export type BrowserInput = z.infer<typeof BrowserInputSchema>;
export type BrowserOutput = z.infer<typeof BrowserOutputSchema>;

export { BrowserInputSchema, BrowserOutputSchema };

//#endregion

//#region Tool description

const BROWSER_DESCRIPTION = `Drive a real Chrome instance through the agent-browser CLI.

Use this for frontend probes — navigate to a URL, snapshot the accessibility
tree (returns @ref-style element handles), click / fill / type / press keys,
take screenshots, wait for text or selectors, evaluate JS in the page.

Workflow:
 1. \`navigate\` to the URL.
 2. \`snapshot\` to get the accessibility tree with @e1-style refs.
 3. \`click\`, \`fill\`, etc. using those refs (or CSS selectors).
 4. \`screenshot\` for visual evidence.
 5. \`close\` (optionally with \`all: true\`) when done.

agent-browser bundles its own Chrome (downloaded via the postinstall script).
The daemon persists between calls; closing on completion is polite but not
strictly required.`;

//#endregion

//#region Binary resolution

const require = createRequire(import.meta.url);

const MISSING_BINARY_MESSAGE =
  'agent-browser binary not found. Install the project dependencies (`bun install`) to populate node_modules/.bin, then run `bunx agent-browser install` once to download Chrome.';

function resolveAgentBrowserBin(): string | null {
  try {
    const pkgJsonPath = require.resolve('agent-browser/package.json');
    return join(dirname(pkgJsonPath), 'bin', 'agent-browser.js');
  } catch {
    return null;
  }
}

const AGENT_BROWSER_BIN: string | null = resolveAgentBrowserBin();

//#endregion

//#region Argv builders

interface BuiltCommand {
  args: ReadonlyArray<string>;
}

function buildNavigate(input: z.infer<typeof NavigateSchema>): BuiltCommand {
  return {
    args: [
      'open',
      input.url,
    ],
  };
}

function buildSnapshot(): BuiltCommand {
  return {
    args: [
      'snapshot',
    ],
  };
}

function buildScreenshot(input: z.infer<typeof ScreenshotSchema>): BuiltCommand {
  const args: string[] = [
    'screenshot',
  ];
  if (input.path !== undefined) {
    args.push(input.path);
  }
  return {
    args,
  };
}

function buildClick(input: z.infer<typeof ClickSchema>): BuiltCommand {
  return {
    args: [
      'click',
      input.ref,
    ],
  };
}

function buildFill(input: z.infer<typeof FillSchema>): BuiltCommand {
  return {
    args: [
      'fill',
      input.ref,
      input.value,
    ],
  };
}

function buildType(input: z.infer<typeof TypeSchema>): BuiltCommand {
  return {
    args: [
      'keyboard',
      'type',
      input.text,
    ],
  };
}

function buildKey(input: z.infer<typeof KeySchema>): BuiltCommand {
  return {
    args: [
      'press',
      input.key,
    ],
  };
}

function buildWaitFor(input: z.infer<typeof WaitForSchema>): BuiltCommand {
  const args: string[] = [
    'wait',
    input.text,
  ];
  if (input.timeoutMs !== undefined) {
    args.push('--timeout', String(input.timeoutMs));
  }
  return {
    args,
  };
}

function buildEval(input: z.infer<typeof EvalSchema>): BuiltCommand {
  return {
    args: [
      'eval',
      input.js,
    ],
  };
}

function buildClose(input: z.infer<typeof CloseSchema>): BuiltCommand {
  const args: string[] = [
    'close',
  ];
  if (input.all === true) {
    args.push('--all');
  }
  return {
    args,
  };
}

// Switch is used instead of a handler registry because each case requires a
// narrowed discriminated-union type. A Record<string, Handler> would lose
// that narrowing and require unsafe casts.
function dispatchHandler(input: InternalInput): BuiltCommand {
  switch (input.action) {
    case 'navigate':
      return buildNavigate(input);
    case 'snapshot':
      return buildSnapshot();
    case 'screenshot':
      return buildScreenshot(input);
    case 'click':
      return buildClick(input);
    case 'fill':
      return buildFill(input);
    case 'type':
      return buildType(input);
    case 'key':
      return buildKey(input);
    case 'wait_for':
      return buildWaitFor(input);
    case 'eval':
      return buildEval(input);
    case 'close':
      return buildClose(input);
  }
}

function buildShellLine(binary: string, built: BuiltCommand): string {
  const parts: string[] = [
    shellQuote(binary),
  ];
  for (const arg of built.args) {
    parts.push(shellQuote(arg));
  }
  parts.push('--json');
  return parts.join(' ');
}

//#endregion

//#region Output helpers

function missingBinaryResult(action: string): BrowserOutput {
  return {
    output: `Error: ${MISSING_BINARY_MESSAGE}`,
    action,
    truncated: false,
  };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

interface BuildOutputParams {
  action: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function buildOutput(params: BuildOutputParams): BrowserOutput {
  const { action, stdout, stderr, exitCode } = params;
  const exit = exitCode ?? undefined;
  const isFailure = exit !== undefined && exit !== 0;

  const raw = isFailure && stderr.length > 0 ? `${stdout}\n${stderr}`.trimStart() : stdout;
  const truncation = truncateTail(raw);
  let body = truncation.content;
  if (truncation.truncated) {
    body += `\n\n[Output truncated to last ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} (${formatSize(DEFAULT_MAX_BYTES)} limit).]`;
  }

  return {
    output: body || '(no output)',
    exitCode: exit,
    action,
    truncated: truncation.truncated,
  };
}

//#endregion

//#region Public API

export type BrowserTool = Tool<typeof BrowserInputSchema, typeof BrowserOutputSchema>;

export function createBrowserTool(cwd: string, shell: ShellAdapter): BrowserTool {
  return tool({
    name: 'browser',
    description: BROWSER_DESCRIPTION,
    input: BrowserInputSchema,
    output: BrowserOutputSchema,
    async execute(rawParams, toolCtx): Promise<BrowserOutput> {
      const liveCwd = getToolCwd(toolCtx.ctx, cwd);
      const parsed = InternalInputSchema.safeParse(rawParams);
      if (!parsed.success) {
        return {
          output: `Error: invalid params for action "${rawParams.action}": ${formatZodIssues(parsed.error)}`,
          action: rawParams.action,
          truncated: false,
        };
      }
      if (AGENT_BROWSER_BIN === null) {
        return missingBinaryResult(parsed.data.action);
      }
      const built = dispatchHandler(parsed.data);
      const line = buildShellLine(AGENT_BROWSER_BIN, built);
      const result = await shell.exec(line, {
        cwd: liveCwd,
      });
      return buildOutput({
        action: parsed.data.action,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    },
  });
}

//#endregion
