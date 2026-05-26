/**
 * Default values shared by the planner / implementer / validator
 * subprocesses and the daemon harness wiring. Centralised so a model
 * upgrade only touches one file.
 */

/**
 * Default OpenRouter model id used by the autonomous planner, implementer,
 * and adversarial-review LLM steps when neither the caller nor
 * `NOETIC_MODEL` env var supplies an override.
 */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';
