import * as path from 'node:path';
import * as ts from 'typescript';

//#region Types

interface ResolvedImport {
  symbolName: string;
  resolvedFilePath: string;
}

//#endregion

//#region Helper Functions

interface ResolveModuleOpts {
  moduleSpecifier: string;
  containingFile: string;
  compilerOptions: ts.CompilerOptions;
  host: ts.CompilerHost;
}

function resolveModuleSpecifier(opts: ResolveModuleOpts): string | undefined {
  const result = ts.resolveModuleName(
    opts.moduleSpecifier,
    opts.containingFile,
    opts.compilerOptions,
    opts.host,
  );
  return result.resolvedModule?.resolvedFileName;
}

//#endregion

//#region Public API

export function resolveImports(evalFilePath: string): ResolvedImport[] {
  const absolutePath = path.resolve(evalFilePath);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: true,
  };

  const host = ts.createCompilerHost(compilerOptions);
  const sourceFile = ts.createSourceFile(
    absolutePath,
    ts.sys.readFile(absolutePath) ?? '',
    ts.ScriptTarget.ESNext,
    true,
  );

  const imports: ResolvedImport[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const moduleSpecifier = statement.moduleSpecifier.text;
    const resolvedPath = resolveModuleSpecifier({
      moduleSpecifier,
      containingFile: absolutePath,
      compilerOptions,
      host,
    });

    if (!resolvedPath) {
      continue;
    }

    const importClause = statement.importClause;
    if (!importClause) {
      continue;
    }

    if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
      for (const element of importClause.namedBindings.elements) {
        imports.push({
          symbolName: element.name.text,
          resolvedFilePath: resolvedPath,
        });
      }
    }

    if (importClause.name) {
      imports.push({
        symbolName: importClause.name.text,
        resolvedFilePath: resolvedPath,
      });
    }
  }

  return imports;
}

//#endregion
