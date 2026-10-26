import type { Item, ItemLog, ItemSchemaRegistry } from '@noetic-tools/types';
import { defaultItemSchemaRegistry } from '@noetic-tools/types';

export class ItemLogImpl implements ItemLog {
  private readonly _items: Item[] = [];
  private _frozenCache: ReadonlyArray<Item> | null = null;

  constructor(private itemSchemas: ItemSchemaRegistry = defaultItemSchemaRegistry) {}

  /**
   * @internal
   * Validate later appends against `registry`, a superset of the current one: a
   * context that learns of new item types (a step's custom items) widens its log.
   */
  useSchemas(registry: ItemSchemaRegistry): void {
    this.itemSchemas = registry;
  }

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

  /**
   * @internal
   * Swap the whole log for `items`. Only for a context rebuilding itself from storage
   * before a run starts; nothing reads a log while it is replaced.
   */
  replace(items: ReadonlyArray<Item>): void {
    this._items.length = 0;
    for (const item of items) {
      this._items.push(this.itemSchemas.parse(item));
    }
    this._frozenCache = null;
  }

  append(item: Item): void {
    this._items.push(this.itemSchemas.parse(item));
    this._frozenCache = null;
  }
}
