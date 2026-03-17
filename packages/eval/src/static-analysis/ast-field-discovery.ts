import * as path from 'node:path';
import * as ts from 'typescript';

import type { OptimizableField } from '../types/optimizer';
import { FieldKind } from '../types/optimizer';
import type { SourceLocation } from '../types/source-location';
import { resolveImports } from './import-resolver';

//#region Types

interface AstDiscoveryContext {
  fields: OptimizableField[];
  sourceFile: ts.SourceFile;
  filePath: string;
}

//#endregion

//#region Constants

const BUILDER_NAMES = new Set([
  'react',
  'ralphWiggum',
  'branch',
  'fork',
  'spawn',
  'loop',
]);

const STEP_METHOD_NAMES = new Set([
  'llm',
  'run',
  'tool',
]);

//#endregion

//#region Helper Functions

function getSourceLocation(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): SourceLocation {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    filePath,
    line: line + 1,
    column: character + 1,
  };
}

function extractStringLiteral(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function extractIdFromObjectLiteral(objectLiteral: ts.ObjectLiteralExpression): string | undefined {
  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    if (!ts.isIdentifier(prop.name) || prop.name.text !== 'id') {
      continue;
    }
    return extractStringLiteral(prop.initializer);
  }
  return undefined;
}

function processSystemField(
  ctx: AstDiscoveryContext,
  prop: ts.PropertyAssignment,
  stepId: string,
): void {
  const value = extractStringLiteral(prop.initializer);
  if (!value) {
    return;
  }
  ctx.fields.push({
    path: `${stepId}.system`,
    value,
    stepId,
    fieldKind: FieldKind.System,
    sourceLocation: getSourceLocation(prop.initializer, ctx.sourceFile, ctx.filePath),
  });
}

function processToolArray(
  ctx: AstDiscoveryContext,
  prop: ts.PropertyAssignment,
  stepId: string,
): void {
  if (!ts.isArrayLiteralExpression(prop.initializer)) {
    return;
  }
  for (const element of prop.initializer.elements) {
    if (!ts.isIdentifier(element)) {
      continue;
    }
    // Tool references in arrays are identifiers — we record the reference location
    ctx.fields.push({
      path: `${stepId}.tools.${element.text}`,
      value: element.text,
      stepId,
      fieldKind: FieldKind.ToolName,
      sourceLocation: getSourceLocation(element, ctx.sourceFile, ctx.filePath),
    });
  }
}

function processBuilderObjectLiteral(
  ctx: AstDiscoveryContext,
  objectLiteral: ts.ObjectLiteralExpression,
): void {
  const stepId = extractIdFromObjectLiteral(objectLiteral);
  if (!stepId) {
    return;
  }

  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    if (!ts.isIdentifier(prop.name)) {
      continue;
    }

    const propName = prop.name.text;
    if (propName === 'system') {
      processSystemField(ctx, prop, stepId);
      continue;
    }
    if (propName === 'tools') {
      processToolArray(ctx, prop, stepId);
    }
  }
}

function processToolBuilderCall(
  ctx: AstDiscoveryContext,
  objectLiteral: ts.ObjectLiteralExpression,
): void {
  let toolName: string | undefined;
  let descriptionProp: ts.PropertyAssignment | undefined;
  let nameProp: ts.PropertyAssignment | undefined;

  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    if (!ts.isIdentifier(prop.name)) {
      continue;
    }

    if (prop.name.text === 'name') {
      toolName = extractStringLiteral(prop.initializer);
      nameProp = prop;
    }
    if (prop.name.text === 'description') {
      descriptionProp = prop;
    }
  }

  if (!toolName) {
    return;
  }

  if (descriptionProp) {
    const descValue = extractStringLiteral(descriptionProp.initializer);
    if (descValue) {
      ctx.fields.push({
        path: `${toolName}.description`,
        value: descValue,
        stepId: toolName,
        fieldKind: FieldKind.ToolDescription,
        sourceLocation: getSourceLocation(
          descriptionProp.initializer,
          ctx.sourceFile,
          ctx.filePath,
        ),
      });
    }
  }

  if (nameProp) {
    ctx.fields.push({
      path: `${toolName}.name`,
      value: toolName,
      stepId: toolName,
      fieldKind: FieldKind.ToolName,
      sourceLocation: getSourceLocation(nameProp.initializer, ctx.sourceFile, ctx.filePath),
    });
  }
}

function isBuilderCall(expression: ts.Expression):
  | {
      functionName: string;
    }
  | undefined {
  if (ts.isIdentifier(expression)) {
    if (BUILDER_NAMES.has(expression.text)) {
      return {
        functionName: expression.text,
      };
    }
    return undefined;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const objectName = ts.isIdentifier(expression.expression) ? expression.expression.text : '';
    const methodName = expression.name.text;

    if (objectName === 'step' && STEP_METHOD_NAMES.has(methodName)) {
      return {
        functionName: `step.${methodName}`,
      };
    }

    if (objectName === 'tool' || (BUILDER_NAMES.has(methodName) && objectName === '')) {
      return {
        functionName: methodName,
      };
    }
  }

  return undefined;
}

function visitNode(ctx: AstDiscoveryContext, node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const builderInfo = isBuilderCall(node.expression);
    if (builderInfo && node.arguments.length > 0) {
      const firstArg = node.arguments[0];
      if (ts.isObjectLiteralExpression(firstArg)) {
        if (builderInfo.functionName === 'tool') {
          processToolBuilderCall(ctx, firstArg);
        } else {
          processBuilderObjectLiteral(ctx, firstArg);
        }
      }
    }
  }

  ts.forEachChild(node, (child) => visitNode(ctx, child));
}

//#endregion

//#region Public API

export function discoverFieldsFromSource(evalFilePath: string): OptimizableField[] {
  const absoluteEvalPath = path.resolve(evalFilePath);
  const allFields: OptimizableField[] = [];

  const filesToAnalyze = new Set<string>();

  const imports = resolveImports(absoluteEvalPath);
  for (const imp of imports) {
    filesToAnalyze.add(imp.resolvedFilePath);
  }

  for (const filePath of filesToAnalyze) {
    const content = ts.sys.readFile(filePath);
    if (!content) {
      continue;
    }

    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.ESNext, true);

    const ctx: AstDiscoveryContext = {
      fields: [],
      sourceFile,
      filePath,
    };

    visitNode(ctx, sourceFile);
    allFields.push(...ctx.fields);
  }

  return allFields;
}

//#endregion
