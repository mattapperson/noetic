/**
 * @internal
 * Test-only exports for cross-package testing.
 *
 * These are implementation classes that tests need to construct mock instances.
 * Application code should NEVER import from this path.
 */

export { SpanImpl } from './observability/span-impl';
export { ChannelStore } from './runtime/channel-store';
export { ContextImpl } from './runtime/context-impl';
export { ItemLogImpl } from './runtime/item-log-impl';
