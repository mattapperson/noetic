/**
 * Operation dispatch + output formatters. Each of the 9 operations turns a
 * raw protocol response into a human-readable string the tool returns to the
 * model. Formatting server-side keeps the tool output schema flat.
 */

import { fileURLToPath } from 'node:url';

import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  Position,
  Range,
  SymbolInformation,
  WorkspaceSymbol,
} from 'vscode-languageserver-protocol';
import { SymbolKind } from 'vscode-languageserver-protocol';

//#region Types

export const LspOperation = {
  GoToDefinition: 'goToDefinition',
  FindReferences: 'findReferences',
  Hover: 'hover',
  DocumentSymbol: 'documentSymbol',
  WorkspaceSymbol: 'workspaceSymbol',
  GoToImplementation: 'goToImplementation',
  PrepareCallHierarchy: 'prepareCallHierarchy',
  IncomingCalls: 'incomingCalls',
  OutgoingCalls: 'outgoingCalls',
} as const;

export type LspOperation = (typeof LspOperation)[keyof typeof LspOperation];

//#endregion

//#region Formatters

function toDisplayPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

function formatPosition(line: number, character: number): string {
  return `${line + 1}:${character + 1}`;
}

function formatLocation(loc: { uri: string; range: Range }): string {
  const path = toDisplayPath(loc.uri);
  return `${path}:${formatPosition(loc.range.start.line, loc.range.start.character)}`;
}

function formatLocations(locations: ReadonlyArray<Location>): string {
  if (locations.length === 0) {
    return 'No results.';
  }
  return locations.map((loc) => `- ${formatLocation(loc)}`).join('\n');
}

function formatLocationLinks(links: ReadonlyArray<LocationLink>): string {
  if (links.length === 0) {
    return 'No results.';
  }
  return links
    .map((link) => {
      const path = toDisplayPath(link.targetUri);
      return `- ${path}:${formatPosition(link.targetRange.start.line, link.targetRange.start.character)}`;
    })
    .join('\n');
}

function extractHoverContent(hover: Hover): string {
  const { contents } = hover;
  if (typeof contents === 'string') {
    return contents;
  }
  if (Array.isArray(contents)) {
    return contents.map(renderMarkedString).join('\n\n');
  }
  return renderMarkedString(contents);
}

function renderMarkedString(marked: MarkedString | MarkupContent): string {
  if (typeof marked === 'string') {
    return marked;
  }
  return marked.value;
}

const symbolKindLabels: Partial<Record<SymbolKind, string>> = {
  [SymbolKind.File]: 'file',
  [SymbolKind.Module]: 'module',
  [SymbolKind.Namespace]: 'namespace',
  [SymbolKind.Package]: 'package',
  [SymbolKind.Class]: 'class',
  [SymbolKind.Method]: 'method',
  [SymbolKind.Property]: 'property',
  [SymbolKind.Field]: 'field',
  [SymbolKind.Constructor]: 'constructor',
  [SymbolKind.Enum]: 'enum',
  [SymbolKind.Interface]: 'interface',
  [SymbolKind.Function]: 'function',
  [SymbolKind.Variable]: 'variable',
  [SymbolKind.Constant]: 'constant',
  [SymbolKind.String]: 'string',
  [SymbolKind.Number]: 'number',
  [SymbolKind.Boolean]: 'boolean',
  [SymbolKind.Array]: 'array',
  [SymbolKind.Object]: 'object',
  [SymbolKind.Key]: 'key',
  [SymbolKind.Null]: 'null',
  [SymbolKind.EnumMember]: 'enumMember',
  [SymbolKind.Struct]: 'struct',
  [SymbolKind.Event]: 'event',
  [SymbolKind.Operator]: 'operator',
  [SymbolKind.TypeParameter]: 'typeParameter',
};

function symbolKindLabel(kind: SymbolKind): string {
  return symbolKindLabels[kind] ?? `kind(${kind})`;
}

function formatDocumentSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[],
  filePath: string,
): string {
  if (symbols.length === 0) {
    return 'No symbols.';
  }
  if (isDocumentSymbolArray(symbols)) {
    const lines: string[] = [];
    renderDocumentSymbolTree({
      symbols,
      filePath,
      depth: 0,
      out: lines,
    });
    return lines.join('\n');
  }
  return symbols
    .map((s) => {
      const loc = formatLocation({
        uri: s.location.uri,
        range: s.location.range,
      });
      return `- ${symbolKindLabel(s.kind)} ${s.name}  (${loc})`;
    })
    .join('\n');
}

function isDocumentSymbolArray(
  symbols: DocumentSymbol[] | SymbolInformation[],
): symbols is DocumentSymbol[] {
  const first = symbols[0];
  if (!first) {
    return false;
  }
  return 'range' in first && 'selectionRange' in first;
}

interface RenderTreeArgs {
  symbols: ReadonlyArray<DocumentSymbol>;
  filePath: string;
  depth: number;
  out: string[];
}

function renderDocumentSymbolTree(args: RenderTreeArgs): void {
  const { symbols, filePath, depth, out } = args;
  const indent = '  '.repeat(depth);
  for (const s of symbols) {
    const pos = formatPosition(s.selectionRange.start.line, s.selectionRange.start.character);
    out.push(`${indent}- ${symbolKindLabel(s.kind)} ${s.name}  (${filePath}:${pos})`);
    if (s.children && s.children.length > 0) {
      renderDocumentSymbolTree({
        symbols: s.children,
        filePath,
        depth: depth + 1,
        out,
      });
    }
  }
}

function formatWorkspaceSymbols(symbols: SymbolInformation[] | WorkspaceSymbol[]): string {
  if (symbols.length === 0) {
    return 'No results.';
  }
  return symbols.map(formatWorkspaceSymbol).join('\n');
}

function formatWorkspaceSymbol(sym: SymbolInformation | WorkspaceSymbol): string {
  const { location } = sym;
  const kind = symbolKindLabel(sym.kind);
  if ('range' in location) {
    return `- ${kind} ${sym.name}  (${formatLocation(location)})`;
  }
  return `- ${kind} ${sym.name}  (${toDisplayPath(location.uri)})`;
}

function formatCallHierarchyItems(items: ReadonlyArray<CallHierarchyItem>): string {
  if (items.length === 0) {
    return 'No hierarchy items at this position.';
  }
  return items
    .map((item) => {
      const path = toDisplayPath(item.uri);
      const pos = formatPosition(
        item.selectionRange.start.line,
        item.selectionRange.start.character,
      );
      return `- ${symbolKindLabel(item.kind)} ${item.name}  (${path}:${pos})`;
    })
    .join('\n');
}

function formatIncomingCalls(calls: ReadonlyArray<CallHierarchyIncomingCall>): string {
  if (calls.length === 0) {
    return 'No incoming calls.';
  }
  return calls
    .map((call) => {
      const caller = call.from;
      const path = toDisplayPath(caller.uri);
      const pos = formatPosition(
        caller.selectionRange.start.line,
        caller.selectionRange.start.character,
      );
      const sites = call.fromRanges
        .map((r) => formatPosition(r.start.line, r.start.character))
        .join(', ');
      return `- ${symbolKindLabel(caller.kind)} ${caller.name}  (${path}:${pos})  calls at: ${sites}`;
    })
    .join('\n');
}

function formatOutgoingCalls(calls: ReadonlyArray<CallHierarchyOutgoingCall>): string {
  if (calls.length === 0) {
    return 'No outgoing calls.';
  }
  return calls
    .map((call) => {
      const callee = call.to;
      const path = toDisplayPath(callee.uri);
      const pos = formatPosition(
        callee.selectionRange.start.line,
        callee.selectionRange.start.character,
      );
      const sites = call.fromRanges
        .map((r) => formatPosition(r.start.line, r.start.character))
        .join(', ');
      return `- ${symbolKindLabel(callee.kind)} ${callee.name}  (${path}:${pos})  called from: ${sites}`;
    })
    .join('\n');
}

//#endregion

//#region Public API

export function formatHover(hover: Hover | null): string {
  if (!hover) {
    return 'No hover information at this position.';
  }
  return extractHoverContent(hover);
}

function isLocationLinkArray(arr: ReadonlyArray<Location | LocationLink>): arr is LocationLink[] {
  const first = arr[0];
  return !!first && 'targetUri' in first;
}

export function formatDefinitionResult(
  result: Location | Location[] | LocationLink[] | null,
): string {
  if (!result) {
    return 'No definition found.';
  }
  if (!Array.isArray(result)) {
    return formatLocations([
      result,
    ]);
  }
  if (result.length === 0) {
    return 'No definition found.';
  }
  if (isLocationLinkArray(result)) {
    return formatLocationLinks(result);
  }
  return formatLocations(result);
}

export function formatReferencesResult(result: Location[] | null): string {
  if (!result || result.length === 0) {
    return 'No references found.';
  }
  return formatLocations(result);
}

export function formatDocumentSymbolsResult(
  result: DocumentSymbol[] | SymbolInformation[] | null,
  filePath: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found.';
  }
  return formatDocumentSymbols(result, filePath);
}

export function formatWorkspaceSymbolsResult(
  result: SymbolInformation[] | WorkspaceSymbol[] | null,
): string {
  if (!result) {
    return 'No results.';
  }
  return formatWorkspaceSymbols(result);
}

export function formatCallHierarchyPrepareResult(result: CallHierarchyItem[] | null): string {
  if (!result || result.length === 0) {
    return 'No hierarchy items at this position.';
  }
  return formatCallHierarchyItems(result);
}

export function formatIncomingCallsResult(result: CallHierarchyIncomingCall[] | null): string {
  if (!result) {
    return 'No incoming calls.';
  }
  return formatIncomingCalls(result);
}

export function formatOutgoingCallsResult(result: CallHierarchyOutgoingCall[] | null): string {
  if (!result) {
    return 'No outgoing calls.';
  }
  return formatOutgoingCalls(result);
}

/**
 * Extract the symbol-at-position to use as a workspace-symbol query.
 * Returns null if no identifier-ish token sits under the cursor.
 */
export function extractWordAtPosition(text: string, position: Position): string | null {
  const lines = text.split(/\r?\n/);
  const line = lines[position.line];
  if (!line) {
    return null;
  }
  const wordRegex = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match = wordRegex.exec(line);
  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return match[0];
    }
    match = wordRegex.exec(line);
  }
  return null;
}

//#endregion
