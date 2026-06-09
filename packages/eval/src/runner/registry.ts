import type { SuiteDefinition } from './suite-types';

//#region State

const suites: SuiteDefinition[] = [];

//#endregion

//#region Public API

export function registerSuite(suite: SuiteDefinition): void {
  suites.push(suite);
}

export function getSuites(): ReadonlyArray<SuiteDefinition> {
  return suites;
}

export function clearSuites(): void {
  suites.length = 0;
}

//#endregion
