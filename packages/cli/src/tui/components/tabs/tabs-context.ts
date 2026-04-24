import { createContext } from 'react';

//#region Types

export interface TabsContextValue {
  selectedTab: string | undefined;
  headerFocused: boolean;
  focusHeader: () => void;
  blurHeader: () => void;
}

//#endregion

//#region Context

export const TabsContext = createContext<TabsContextValue>({
  selectedTab: undefined,
  headerFocused: false,
  focusHeader: () => {},
  blurHeader: () => {},
});

//#endregion
