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

  /** @internal Current length — used as a rollback watermark by the session runner. */
  get length(): number {
    return this._items.length;
  }

  /**
   * @internal Roll the log back to a previously-captured watermark. Used ONLY
   * by the session runner to discard a failed/aborted turn's partial items so
   * a shared session log preserves the same "failed turns leave no trace"
   * semantics the copy-based history had.
   */
  truncateTo(watermark: number): void {
    if (watermark < 0 || watermark >= this._items.length) {
      return;
    }
    this._items.length = watermark;
    this._frozenCache = null;
  }
}
