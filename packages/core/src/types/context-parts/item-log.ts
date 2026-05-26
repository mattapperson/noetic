import type { Item } from '../items';

/** @public Append-only log of conversation items accumulated during execution. */
export interface ItemLog {
  readonly items: ReadonlyArray<Item>;
  append(item: Item): void;
}
