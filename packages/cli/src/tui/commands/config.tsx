/**
 * /config command — editable tab-based configuration TUI.
 */

import type { ReactNode } from 'react';

import { discoverConfig } from '../../config/discovery.js';
import type { Command, LocalJsxCommandCall } from '../../commands/types.js';
import { ConfigEditor } from './config/editor.js';
import { CONFIG_TAB_ORDER, ConfigTab } from './config/types.js';

//#region Helpers

function parseInitialTab(args: string): ConfigTab {
  const trimmed = args.trim().toLowerCase();
  if (!trimmed) {
    return ConfigTab.Model;
  }
  const exact = CONFIG_TAB_ORDER.find((id) => id === trimmed);
  if (exact) {
    return exact;
  }
  const prefix = CONFIG_TAB_ORDER.find((id) => id.startsWith(trimmed));
  return prefix ?? ConfigTab.Model;
}

//#endregion

//#region Command

const call: LocalJsxCommandCall = async (onDone, ctx, args): Promise<ReactNode> => {
  const initialTab = parseInitialTab(args);
  const discovered = await discoverConfig();
  const sourcePath = discovered?.sourcePath;
  const handleCancel = (message?: string): void => {
    onDone(message ?? 'Configuration editor closed');
  };
  return (
    <ConfigEditor
      initialTab={initialTab}
      config={discovered?.config ?? ctx.config}
      sourcePath={sourcePath}
      onCancel={handleCancel}
    />
  );
};

export const config: Command = {
  type: 'local-jsx',
  name: 'config',
  description: 'View and edit agent configuration',
  load: async () => ({
    call,
  }),
};

//#endregion
