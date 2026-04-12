/**
 * ScrollArea component for Ink — replaces Gridland's <scrollbox> intrinsic.
 *
 * Uses Ink's <Static> component for append-only rendering, which is ideal for
 * chat logs where messages are added at the bottom. Items are rendered once
 * and kept on screen permanently.
 *
 * For a chat application, this is the recommended approach because:
 * - Messages are append-only (new messages added at the bottom)
 * - Already-rendered messages don't need to update
 * - Terminal scrollback handles "scrolling up" naturally
 */

import { Box, Static } from 'ink';
import type { ReactNode } from 'react';
import { Children, isValidElement } from 'react';

//#region Types

export interface ScrollAreaProps {
  /**
   * Content to render inside the scroll area.
   * Can be a single ReactNode or an array of ReactNodes.
   */
  children: ReactNode;
  /**
   * Flexbox flex value — matches Gridland's <scrollbox flex={1}> behavior.
   * When set to 1, the component fills available space.
   */
  flex?: number;
}

interface ItemWrapper {
  key: string;
  node: ReactNode;
}

//#endregion

//#region Helpers

/**
 * Convert children to an array of keyed item wrappers for Static.
 * Children.toArray already generates stable, unique keys for all elements.
 */
function childrenToItems(children: ReactNode): ItemWrapper[] {
  return Children.toArray(children).map((child, index) => ({
    key: isValidElement(child) && child.key !== null ? String(child.key) : `item-${index}`,
    node: child,
  }));
}

//#endregion

//#region Component

/**
 * ScrollArea wraps content in Ink's <Static> component for append-only rendering.
 *
 * This is suitable for chat interfaces where:
 * - Messages are added at the bottom
 * - Previously rendered messages don't change
 * - Users scroll up using terminal scrollback
 *
 * @example
 * ```tsx
 * <ScrollArea flex={1}>
 *   {messages.map((msg) => (
 *     <Message key={msg.id} {...msg} />
 *   ))}
 * </ScrollArea>
 * ```
 */
export function ScrollArea({ children, flex }: ScrollAreaProps): ReactNode {
  const items = childrenToItems(children);

  return (
    <Box flexDirection="column" flexGrow={flex}>
      <Static items={items}>{(item: ItemWrapper) => <Box key={item.key}>{item.node}</Box>}</Static>
    </Box>
  );
}

//#endregion
