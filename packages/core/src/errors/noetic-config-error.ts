/**
 * @public
 * Configuration-time error thrown during construction and setup.
 *
 * `NoeticConfigError` is separate from `NoeticError`. The two are never interchangeable:
 * - `NoeticError` — thrown during execution (LLM failures, fork failures, budget exceeded).
 * - `NoeticConfigError` — thrown during construction (invalid step config, missing env vars, runtime misconfiguration).
 *
 * @example
 * ```ts
 * try {
 *   loop({ id: '', steps: [], until: until.maxSteps(10) });
 * } catch (e) {
 *   if (isNoeticConfigError(e)) {
 *     console.error(e.code, e.hint);
 *   }
 * }
 * ```
 */
export class NoeticConfigError extends Error {
  /** SCREAMING_SNAKE_CASE code uniquely identifying this error condition. */
  readonly code: string;
  /** Complete sentence describing what the user should do next. */
  readonly hint: string;
  /** Link to the relevant docs page, if available. */
  readonly docsUrl?: string;

  constructor(opts: {
    code: string;
    message: string;
    hint: string;
    docsUrl?: string;
  }) {
    super(opts.message);
    this.name = 'NoeticConfigError';
    this.code = opts.code;
    this.hint = opts.hint;
    this.docsUrl = opts.docsUrl;
  }
}

/**
 * @public
 * Type guard for `NoeticConfigError`.
 *
 * @param e - Value to check.
 * @returns `true` if `e` is a `NoeticConfigError`.
 */
export function isNoeticConfigError(e: unknown): e is NoeticConfigError {
  return e instanceof NoeticConfigError;
}
