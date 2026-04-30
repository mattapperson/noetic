//#region Type guards

/** True when `value` is a `node:fs` error carrying a `string` code. */
export function isErrorWithCode(value: unknown): value is Error & {
  code: string;
} {
  if (!(value instanceof Error)) {
    return false;
  }
  if (!('code' in value)) {
    return false;
  }
  return typeof value.code === 'string';
}

/** True when `err` is an ENOENT (no-such-file-or-directory) error. */
export function isEnoent(err: unknown): boolean {
  return isErrorWithCode(err) && err.code === 'ENOENT';
}

//#endregion
