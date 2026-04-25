/**
 * Session-scoped in-memory store for pasted images referenced by the
 * ask-user modal's "Other" text input.
 *
 * Ported from ~/Desktop/claude-code-main/src/utils/imageStore.ts. Each paste
 * is assigned a monotonically-increasing numeric id which the input template
 * can reference (e.g. `[image #3]`). The store is a singleton for the
 * lifetime of the TUI process.
 */

import type { ImageDimensions } from './image-resizer.js';

//#region Types

export interface StoredImage {
  readonly id: number;
  readonly base64: string;
  readonly mediaType: string;
  readonly dimensions: ImageDimensions | null;
  readonly filename: string | null;
  readonly sourcePath: string | null;
  readonly storedAt: number;
}

export interface ImageStore {
  add(image: Omit<StoredImage, 'id' | 'storedAt'>): StoredImage;
  get(id: number): StoredImage | undefined;
  remove(id: number): boolean;
  list(): ReadonlyArray<StoredImage>;
  clear(): void;
}

//#endregion

//#region Factory

export function createImageStore(): ImageStore {
  const map = new Map<number, StoredImage>();
  let nextId = 1;
  return {
    add(image) {
      const id = nextId++;
      const stored: StoredImage = {
        ...image,
        id,
        storedAt: Date.now(),
      };
      map.set(id, stored);
      return stored;
    },
    get(id) {
      return map.get(id);
    },
    remove(id) {
      return map.delete(id);
    },
    list() {
      return Array.from(map.values());
    },
    clear() {
      map.clear();
    },
  };
}

const singleton = createImageStore();

export function getDefaultImageStore(): ImageStore {
  return singleton;
}

//#endregion
