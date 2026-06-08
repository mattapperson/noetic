import type { Item, ItemLog, ItemSchemaRegistry } from '@noetic-tools/types';
import { defaultItemSchemaRegistry } from '@noetic-tools/types';

export class ItemLogImpl implements ItemLog {
  private readonly _items: Item[] = [];
  private _frozenCache: ReadonlyArray<Item> | null = null;

  constructor(private readonly itemSchemas: ItemSchemaRegistry = defaultItemSchemaRegistry) {}

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
    this._items.push(this.itemSchemas.parse(item));
    this._frozenCache = null;
  }
}
