import type { Context } from '@noetic-tools/types';

/** The topmost ancestor of `ctx`: the run's root, whose id keys what its turn attached. */
export function rootOf(ctx: Context): Context {
  let current: Context = ctx;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}
