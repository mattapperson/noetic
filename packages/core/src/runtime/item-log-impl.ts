import type { ItemLog } from '../types/context';
import type { Item } from '../types/items';

export class ItemLogImpl implements ItemLog {
  private readonly _items: Item[] = [];

  get items(): ReadonlyArray<Item> {
    return Object.freeze([...this._items]);
  }

  append(item: Item): void {
    this._items.push(item);
  }
}
