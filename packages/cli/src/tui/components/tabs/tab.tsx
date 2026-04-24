import { Box } from 'ink';
import type { ReactNode } from 'react';
import { useContext } from 'react';
import { TabsContext } from './tabs-context.js';

//#region Types

export interface TabProps {
  title: string;
  id?: string;
  children?: ReactNode;
}

//#endregion

//#region Component

export function Tab({ title, id, children }: TabProps): ReactNode {
  const { selectedTab } = useContext(TabsContext);
  const ownId = id ?? title;
  if (selectedTab !== ownId) {
    return null;
  }
  return <Box flexDirection="column">{children}</Box>;
}

//#endregion
