import type { StorageAdapter } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import type { StepLedger } from './step-ledger';

/** A pending step record. Retain a tombstone so clearing it can use the same CAS as writing it. */
export class StepIntent {
  private raw: unknown = null;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly key: string,
    private readonly ledger?: StepLedger,
  ) {}

  async read(): Promise<unknown> {
    const raw = await this.storage.get<unknown>(this.key);
    this.raw = raw;
    return isCleared(raw) ? null : raw;
  }

  async write(value: object, retry = false): Promise<void> {
    // Two executors can write the same intent. Give each write its own identity.
    const next = this.storage.swap
      ? {
          ...value,
          writeId: crypto.randomUUID(),
        }
      : value;
    if (this.ledger) {
      try {
        await this.ledger.writeIntent(this.storage, this.key, this.raw, next);
      } catch (error) {
        if (
          !retry ||
          !('writeId' in next) ||
          !isNoeticError(error) ||
          error.noeticError.kind !== 'ledger_write_failed'
        ) {
          throw error;
        }
        const stored = await this.storage.get<unknown>(this.key);
        // A failed acknowledgement can hide a successful write. Otherwise retry
        // the same CAS, so a newer owner's changes still win.
        if (
          stored &&
          typeof stored === 'object' &&
          Reflect.get(stored, 'writeId') === next.writeId
        ) {
          await this.ledger.verifyHeld();
        } else {
          await this.ledger.writeIntent(this.storage, this.key, this.raw, next);
        }
      }
    } else if (this.storage.swap) {
      if (!(await this.storage.swap(this.key, this.raw, next))) {
        throw new Error('The pending record changed.');
      }
    } else {
      await this.storage.set(this.key, next);
    }
    this.raw = next;
  }

  async clear(): Promise<void> {
    if (this.raw === null || isCleared(this.raw)) {
      return;
    }
    if (this.storage.swap) {
      await this.write({
        cleared: true,
      });
    } else {
      await this.ledger?.verifyHeld();
      await this.storage.delete(this.key);
      this.raw = null;
    }
  }
}

function isCleared(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Reflect.get(value, 'cleared') === true;
}
