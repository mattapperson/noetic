import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getFieldValue, setFieldValue } from '../src/commands/builtins/config/accessors.js';
import { saveConfig } from '../src/commands/builtins/config/save.js';
import { serializeConfig } from '../src/commands/builtins/config/serialization.js';
import {
  commitEdit,
  createInitialState,
  resetFocusedField,
  startEditing,
} from '../src/commands/builtins/config/state.js';
import { ConfigTab } from '../src/commands/builtins/config/types.js';
import type { AgentConfig } from '../src/types/config.js';

const baseConfig: AgentConfig = {
  model: 'anthropic/claude-sonnet-4',
  cwd: '/tmp/project',
  apiKey: 'test-key',
  maxTurns: 50,
};

describe('config editor helpers', () => {
  test('updates scalar fields immutably', () => {
    const updated = setFieldValue(baseConfig, 'model', 'openai/gpt-4.1');

    expect(updated.model).toBe('openai/gpt-4.1');
    expect(baseConfig.model).toBe('anthropic/claude-sonnet-4');
  });

  test('tracks dirty fields after committed edits', () => {
    const editing = startEditing(createInitialState(baseConfig, ConfigTab.Model));
    const committed = commitEdit({
      ...editing,
      editValue: 'openai/gpt-4.1',
    });

    expect(committed.draftConfig.model).toBe('openai/gpt-4.1');
    expect(committed.dirtyFields.has('model')).toBe(true);
  });

  test('reset focused field restores original value', () => {
    const editing = startEditing(createInitialState(baseConfig, ConfigTab.Model));
    const committed = commitEdit({
      ...editing,
      editValue: 'openai/gpt-4.1',
    });
    const reset = resetFocusedField(committed);

    expect(getFieldValue(reset.draftConfig, 'model')).toBe('anthropic/claude-sonnet-4');
    expect(reset.dirtyFields.has('model')).toBe(false);
  });

  test('rejects empty list entries', () => {
    const state = createInitialState(baseConfig, ConfigTab.Tools);
    const committed = commitEdit({
      ...state,
      focusedField: 'tools.include',
      editValue: 'read,,write',
    });

    expect(committed.validationErrors.get('tools.include')).toBe('List contains an empty entry');
  });

  test('rejects invalid maxTurns edits', () => {
    const state = createInitialState(baseConfig, ConfigTab.Model);
    const maxTurnsState = {
      ...state,
      focusedField: 'maxTurns' as const,
      editValue: '0',
    };
    const committed = commitEdit(maxTurnsState);

    expect(committed.validationErrors.get('maxTurns')).toBe('Must be a positive integer');
  });

  test('serializes config without undefined fields', () => {
    const content = serializeConfig({
      ...baseConfig,
      tools: {
        include: [
          'read',
        ],
        exclude: undefined,
      },
    });

    expect(content).toContain('import type { AgentConfig }');
    expect(content).toContain('include: [\n      "read",');
    expect(content).not.toContain('exclude');
    expect(content).toContain('satisfies AgentConfig');
  });

  test('does not serialize resolved API key unless the field was edited', () => {
    const content = serializeConfig(baseConfig);

    expect(content).not.toContain('test-key');
    expect(content).toContain('apiKey: process.env.OPENROUTER_API_KEY ?? ""');
  });

  test('serializes edited API key explicitly', () => {
    const content = serializeConfig(
      baseConfig,
      new Set([
        'apiKey',
      ]),
    );

    expect(content).toContain('apiKey: "test-key"');
  });

  test('saveConfig writes serialized config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noetic-config-editor-'));
    await mkdir(dir, {
      recursive: true,
    });
    const sourcePath = join(dir, 'noetic.config.ts');

    await saveConfig({
      config: baseConfig,
      editedFields: new Set(),
      sourcePath,
    });

    const content = await readFile(sourcePath, 'utf8');
    expect(content).toContain('anthropic/claude-sonnet-4');
    expect(content).toContain('satisfies AgentConfig');
  });
});
