/** Batch embedding function — maps N texts to N vectors. */
export type EmbedFn = (texts: readonly string[]) => Promise<readonly number[][]>;
