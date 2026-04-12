import type { ItemLog } from '../types/context';
import type { Item } from '../types/items';

export class ItemLogImpl implements ItemLog {
  private readonly _items: Item[] = [];
  private _frozenCache: ReadonlyArray<Item> | null = null;

  get items(): ReadonlyArray<Item> {
    if (!this._frozenCache) {
      this._frozenCache = Object.freeze([
        ...this._items,
      ]);
    }
    const frozenItems = this._frozenCache;
    if (!frozenItems) {
      return [];
    }
    return frozenItems;
  }

  append(item: Item): void {
    this._items.push(item);
    this._frozenCache = null;
  }
}
