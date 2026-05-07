/**
 * /model command — switch the active OpenRouter model for the session.
 *
 * Usage:
 *   /model           - open the picker modal (browse + filter)
 *   /model <slug>    - set the model directly by OpenRouter slug
 *                      e.g. `/model anthropic/claude-sonnet-4`
 */

import type { ReactNode } from 'react';
import type { Command, LocalJsxCommandCall } from '../../commands/types.js';
import { ModelPicker } from '../components/model-picker.js';

//#region Implementation

const call: LocalJsxCommandCall = async (onDone, ctx, args): Promise<ReactNode> => {
  const trimmed = args.trim();

  if (trimmed.length > 0) {
    try {
      await ctx.setModel(trimmed);
      onDone(`Model set to ${trimmed}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onDone(`Failed to set model: ${message}`);
    }
    return null;
  }

  const currentModel = ctx.config.model;

  const handleSelect = async (modelId: string): Promise<void> => {
    if (modelId === currentModel) {
      onDone(`Kept model as ${modelId}`);
      return;
    }
    try {
      await ctx.setModel(modelId);
      onDone(`Model set to ${modelId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onDone(`Failed to set model: ${message}`);
    }
  };

  const handleCancel = (): void => {
    onDone(`Kept model as ${currentModel}`);
  };

  return (
    <ModelPicker
      currentModel={currentModel}
      onSelect={(id) => void handleSelect(id)}
      onCancel={handleCancel}
    />
  );
};

//#endregion

//#region Command Definition

export const model: Command = {
  type: 'local-jsx',
  name: 'model',
  description: 'Select the active OpenRouter model',
  load: async () => ({
    call,
  }),
};

//#endregion
