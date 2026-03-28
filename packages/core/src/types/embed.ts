/**
 * Batch embedding function — maps N texts to N vectors.
 * @public
 */
export type EmbedFn = (texts: readonly string[]) => Promise<readonly number[][]>;
