/**
 * Tabs — interactive tabbed container for terminal UI.
 *
 * Public API mirrors the Claude Code design-system Tabs component
 * (/Users/mattapperson/Desktop/claude-code-main/src/components/design-system/Tabs.tsx).
 * That source is React-Compiler output; this is a clean Ink-native re-implementation
 * with the same feature set we rely on: header keyboard nav, optional focus model,
 * fixed content height, banner, title, and controlled/uncontrolled selection.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactElement, ReactNode } from 'react';
import { Children, isValidElement, useCallback, useMemo, useState } from 'react';
import type { TabProps } from './tab.js';
import { Tab } from './tab.js';
import { TabsContext } from './tabs-context.js';

//#region Types

export interface TabsProps {
  children: ReactNode;
  title?: string;
  color?: string;
  /** Uncontrolled initial tab id/title. */
  defaultTab?: string;
  /** Controlled selected tab id/title. */
  selectedTab?: string;
  /** Callback fired when the user switches tabs in controlled mode. */
  onTabChange?: (tabId: string) => void;
  /** Optional content rendered between header and tab body. */
  banner?: ReactNode;
  /** Hide header + tab bar entirely (content still renders). */
  hidden?: boolean;
  /** Disable all keyboard navigation. */
  disableNavigation?: boolean;
  /** Start with header focused (default). Set false when the content owns arrow keys. */
  initialHeaderFocused?: boolean;
  /** Fixed height for the content area so switching tabs doesn't reflow. */
  contentHeight?: number;
  /** Allow Tab/←/→ to cycle tabs from focused content. Up arrow re-focuses the header. */
  navFromContent?: boolean;
}

export interface TabMeta {
  id: string;
  title: string;
}

//#endregion

//#region Helpers

function isTabElement(node: ReactNode): node is ReactElement<TabProps> {
  return isValidElement(node) && node.type === Tab;
}

export function collectTabs(children: ReactNode): TabMeta[] {
  const metas: TabMeta[] = [];
  for (const child of Children.toArray(children)) {
    if (!isTabElement(child)) {
      continue;
    }
    const { title, id } = child.props;
    metas.push({
      id: id ?? title,
      title,
    });
  }
  return metas;
}

export function resolveSelectedIndex(
  tabs: TabMeta[],
  controlled: string | undefined,
  internal: number,
): number {
  if (controlled === undefined) {
    return Math.min(internal, Math.max(0, tabs.length - 1));
  }
  const controlledIndex = tabs.findIndex((t) => t.id === controlled);
  if (controlledIndex === -1) {
    return 0;
  }
  return controlledIndex;
}

export function resolveDefaultIndex(tabs: TabMeta[], defaultTab: string | undefined): number {
  if (!defaultTab) {
    return 0;
  }
  const idx = tabs.findIndex((t) => t.id === defaultTab);
  return idx === -1 ? 0 : idx;
}

//#endregion

//#region Component

export function Tabs({
  children,
  title,
  color,
  defaultTab,
  selectedTab: controlledSelectedTab,
  onTabChange,
  banner,
  hidden = false,
  disableNavigation = false,
  initialHeaderFocused = true,
  contentHeight,
  navFromContent = false,
}: TabsProps): ReactNode {
  const tabs = collectTabs(children);
  const isControlled = controlledSelectedTab !== undefined;
  const [internalIndex, setInternalIndex] = useState(() => resolveDefaultIndex(tabs, defaultTab));
  const selectedIndex = resolveSelectedIndex(tabs, controlledSelectedTab, internalIndex);
  const [headerFocused, setHeaderFocused] = useState(initialHeaderFocused);

  const focusHeader = useCallback(() => setHeaderFocused(true), []);
  const blurHeader = useCallback(() => setHeaderFocused(false), []);

  const changeTab = useCallback(
    (offset: number): void => {
      if (tabs.length === 0) {
        return;
      }
      const nextIndex = (selectedIndex + tabs.length + offset) % tabs.length;
      const nextId = tabs[nextIndex]?.id;
      if (isControlled) {
        if (onTabChange && nextId) {
          onTabChange(nextId);
        }
      } else {
        setInternalIndex(nextIndex);
      }
    },
    [
      tabs,
      selectedIndex,
      isControlled,
      onTabChange,
    ],
  );

  const headerNavActive = !hidden && !disableNavigation && headerFocused;
  const contentNavActive = navFromContent && !hidden && !disableNavigation && !headerFocused;
  const navActive = headerNavActive || contentNavActive;

  useInput(
    (_input, key) => {
      // In content mode, a tab/arrow switch also returns focus to the header.
      const refocusOnSwitch = contentNavActive;
      if (key.tab && key.shift) {
        changeTab(-1);
        if (refocusOnSwitch) {
          focusHeader();
        }
        return;
      }
      if (key.tab) {
        changeTab(1);
        if (refocusOnSwitch) {
          focusHeader();
        }
        return;
      }
      if (headerNavActive && key.leftArrow) {
        changeTab(-1);
        return;
      }
      if (headerNavActive && key.rightArrow) {
        changeTab(1);
        return;
      }
      if (headerNavActive && key.downArrow && navFromContent) {
        blurHeader();
        return;
      }
      if (contentNavActive && key.upArrow) {
        focusHeader();
      }
    },
    {
      isActive: navActive,
    },
  );

  const selected = tabs[selectedIndex];
  const contextValue = useMemo(
    () => ({
      selectedTab: selected?.id,
      headerFocused,
      focusHeader,
      blurHeader,
    }),
    [
      selected?.id,
      headerFocused,
      focusHeader,
      blurHeader,
    ],
  );

  return (
    <TabsContext.Provider value={contextValue}>
      <Box flexDirection="column">
        {!hidden && (
          <Box flexDirection="row" gap={1}>
            {title !== undefined && (
              <Text bold color={color}>
                {title}
              </Text>
            )}
            {tabs.map((t, i) => {
              const isCurrent = i === selectedIndex;
              const inverse = isCurrent && headerFocused;
              return (
                <Text
                  key={t.id}
                  bold={isCurrent}
                  color={isCurrent && !inverse ? color : undefined}
                  inverse={inverse}
                >
                  {' '}
                  {t.title}{' '}
                </Text>
              );
            })}
          </Box>
        )}
        {banner}
        <Box
          marginTop={hidden ? 0 : 1}
          flexDirection="column"
          height={contentHeight}
          overflow={contentHeight !== undefined ? 'hidden' : undefined}
        >
          {children}
        </Box>
      </Box>
    </TabsContext.Provider>
  );
}

//#endregion
