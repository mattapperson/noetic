/**
 * `@noetic-tools/types/verify` — the `Verifier` contract and the Open
 * Verification Protocol document types (spec 37), kept apart from the main
 * entry so OVP's `Verdict` never meets Noetic's own `Verdict` (spec 05).
 */
export * from './ovp';
export * from './schemas';
export * from './verifier';
