/**
 * `lsp` tool — single tool with a nine-value `operation` discriminator.
 * Mirrors OpenCode's `sst/opencode` LSP tool surface. Each operation takes a
 * (filePath, line, character) cursor, routed through an `LspService` to the
 * correct language server.
 */

import type { Tool } from '@noetic-tools/core';
import { getToolCwd, tool } from '@noetic-tools/core';
import { z } from 'zod';

import {
  extractWordAtPosition,
  formatCallHierarchyPrepareResult,
  formatDefinitionResult,
  formatDocumentSymbolsResult,
  formatHover,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatReferencesResult,
  formatWorkspaceSymbolsResult,
  LspOperation,
} from '../lsp/operations.js';
import type { LspService, TouchFileResult } from '../lsp/service.js';
import { resolveReadPath } from './path-utils.js';

//#region Schemas

const lspOperationValues = [
  LspOperation.GoToDefinition,
  LspOperation.FindReferences,
  LspOperation.Hover,
  LspOperation.DocumentSymbol,
  LspOperation.WorkspaceSymbol,
  LspOperation.GoToImplementation,
  LspOperation.PrepareCallHierarchy,
  LspOperation.IncomingCalls,
  LspOperation.OutgoingCalls,
] as const;

const LspInputSchema = z.object({
  operation: z
    .enum(lspOperationValues)
    .describe('Which LSP operation to run. See tool description for the nine options.'),
  filePath: z
    .string()
    .describe(
      'Absolute or cwd-relative path to the file containing the symbol. Used to pick the right language server and workspace root.',
    ),
  line: z.number().int().min(1).describe('1-indexed line number (editor display style).'),
  character: z
    .number()
    .int()
    .min(0)
    .describe('0-indexed column offset within the line. Use 0 for start-of-line.'),
});

const LspOutputSchema = z.object({
  operation: z.enum(lspOperationValues),
  results: z
    .string()
    .describe('Human-readable summary — list of locations, hover content, or a symbol tree.'),
});

export type LspOutput = z.infer<typeof LspOutputSchema>;
export type LspTool = Tool<typeof LspInputSchema, typeof LspOutputSchema>;

//#endregion

//#region Description

const LSP_TOOL_DESCRIPTION = `Query the workspace's language servers. Returns structural information about code (definitions, references, types) rather than raw text.

Operations:
 - goToDefinition       — find where a symbol is defined.
 - findReferences       — find all references to a symbol across the workspace.
 - hover                — get type signature and documentation for the symbol at a position.
 - documentSymbol       — list symbols (functions, classes, etc.) declared in a file.
 - workspaceSymbol      — search symbols by name across the workspace. The symbol at (line, character) is used as the query.
 - goToImplementation   — find implementations of an interface method or abstract declaration.
 - prepareCallHierarchy — get the call-hierarchy anchor item at a position (used before incoming/outgoing).
 - incomingCalls        — list functions that call the symbol at this position.
 - outgoingCalls        — list functions called by the symbol at this position.

Inputs: \`filePath\` (absolute or cwd-relative), \`line\` (1-indexed), \`character\` (0-indexed).

Language support is driven by registered contributions. TypeScript/JavaScript, Python, Go, and Swift ship built-in; plugins can register more. If no server handles the file's extension, the tool returns an explanatory message rather than an error.

Prefer this tool over text search when you need to verify a symbol name, understand a type, or navigate the call graph before editing.`;

//#endregion

//#region Handlers

type OperationHandler = (
  touch: TouchFileResult,
  input: z.infer<typeof LspInputSchema>,
  toolInputs: {
    filePath: string;
  },
) => Promise<string>;

async function runHover(
  touch: TouchFileResult,
  input: z.infer<typeof LspInputSchema>,
): Promise<string> {
  const hover = await touch.handle.client.hover(touch.uri, toZeroIndexed(input));
  return formatHover(hover);
}

async function runDefinition(
  touch: TouchFileResult,
  input: z.infer<typeof LspInputSchema>,
): Promise<string> {
  const result = await touch.handle.client.definition(touch.uri, toZeroIndexed(input));
  return formatDefinitionResult(result);
}

async function runImplementation(
  touch: TouchFileResult,
  input: z.infer<typeof LspInputSchema>,
): Promise<string> {
  const result = await touch.handle.client.implementation(touch.uri, toZeroIndexed(input));
  return formatDefinitionResult(result);
}

async function runReferences(
  touch: TouchFileResult,
  input: z.infer<typeof LspInputSchema>,
): Promise<string> {
  const result = await touch.handle.client.references(touch.uri, toZeroIndexed(input));
  return formatReferencesResult(result);
}

async function runDocumentSymbol(
  touch: TouchFileResult,
  _input: z.infer<typeof LspInputSchema>,
  toolInputs: {
    filePath: string;
  },
): Promise<string> {
  const result = await touch.handle.client.documentSymbol(touch.uri);
  return formatDocumentSymbolsResult(result, toolInputs.filePath);
}

async function runWorkspaceSymbol(
  touch: TouchFileResult,
  input: z.infer<typeof LspInputSchema>,
): Promise<string> {
  const query = await resolveQuery(touch, toZeroIndexed(input));
  if (!query) {
    return 'No identifier at the given position to use as a workspace query.';
  }
  const result = await touch.handle.client.workspaceSymbol(query);
  return formatWorkspaceSymbolsResult(result);
}

async function runPrepareCallHierarchy(
  touch: TouchFileResult,
  input: z.infer<typeof LspInputSchema>,
): Promise<string> {
  const result = await touch.handle.client.prepareCallHierarchy(touch.uri, toZeroIndexed(input));
  return formatCallHierarchyPrepareResult(result);
}

async function runIncomingCalls(
  touch: TouchFileResult,
  input: z.infer<typeof LspInputSchema>,
): Promise<string> {
  const items = await touch.handle.client.prepareCallHierarchy(touch.uri, toZeroIndexed(input));
  if (!items || items.length === 0) {
    return 'No call-hierarchy item at this position.';
  }
  const result = await touch.handle.client.incomingCalls(items[0]);
  return formatIncomingCallsResult(result);
}

async function runOutgoingCalls(
  touch: TouchFileResult,
  input: z.infer<typeof LspInputSchema>,
): Promise<string> {
  const items = await touch.handle.client.prepareCallHierarchy(touch.uri, toZeroIndexed(input));
  if (!items || items.length === 0) {
    return 'No call-hierarchy item at this position.';
  }
  const result = await touch.handle.client.outgoingCalls(items[0]);
  return formatOutgoingCallsResult(result);
}

const HANDLERS: Record<LspOperation, OperationHandler> = {
  [LspOperation.Hover]: runHover,
  [LspOperation.GoToDefinition]: runDefinition,
  [LspOperation.GoToImplementation]: runImplementation,
  [LspOperation.FindReferences]: runReferences,
  [LspOperation.DocumentSymbol]: runDocumentSymbol,
  [LspOperation.WorkspaceSymbol]: runWorkspaceSymbol,
  [LspOperation.PrepareCallHierarchy]: runPrepareCallHierarchy,
  [LspOperation.IncomingCalls]: runIncomingCalls,
  [LspOperation.OutgoingCalls]: runOutgoingCalls,
};

//#endregion

//#region Helpers

function toZeroIndexed(input: z.infer<typeof LspInputSchema>): {
  line: number;
  character: number;
} {
  return {
    line: input.line - 1,
    character: input.character,
  };
}

async function resolveQuery(
  touch: TouchFileResult,
  position: {
    line: number;
    character: number;
  },
): Promise<string | null> {
  // Prefer the LSP's own symbol whose selectionRange contains the cursor —
  // this respects server semantics for identifiers like `foo.bar` or macros.
  const symbols = await touch.handle.client.documentSymbol(touch.uri);
  if (symbols) {
    for (const s of symbols) {
      if ('selectionRange' in s) {
        const range = s.selectionRange;
        if (
          position.line === range.start.line &&
          position.character >= range.start.character &&
          position.character <= range.end.character
        ) {
          return s.name;
        }
      }
    }
  }
  // Fallback: extract the identifier under the cursor from file text. Returns
  // null when the cursor isn't on a word — the caller reports that to the model
  // instead of silently substituting an unrelated symbol.
  return extractWordAtPosition(touch.text, position);
}

function buildUnsupportedMessage(filePath: string): string {
  return `No LSP server is registered for '${filePath}'. Register one via a plugin's \`lspServers\` hook, or rely on a shipped builtin (TypeScript/JavaScript, Python, Go, Swift).`;
}

//#endregion

//#region Public API

export function createLspTool(service: LspService, cwd: string): LspTool {
  return tool({
    name: 'lsp',
    description: LSP_TOOL_DESCRIPTION,
    input: LspInputSchema,
    output: LspOutputSchema,
    async execute(input, toolCtx) {
      const liveCwd = getToolCwd(toolCtx.ctx, cwd);
      const absolutePath = resolveReadPath(input.filePath, liveCwd);
      let touch: TouchFileResult | null;
      try {
        touch = await service.touchFile(absolutePath);
      } catch (err) {
        return {
          operation: input.operation,
          results: `LSP error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!touch) {
        return {
          operation: input.operation,
          results: buildUnsupportedMessage(input.filePath),
        };
      }
      const handler = HANDLERS[input.operation];
      try {
        const results = await handler(touch, input, {
          filePath: input.filePath,
        });
        return {
          operation: input.operation,
          results,
        };
      } catch (err) {
        return {
          operation: input.operation,
          results: `LSP ${input.operation} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
}

//#endregion
