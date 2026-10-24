import { describe, expect, it } from 'bun:test';
import {
  configErrorDocsUrl,
  isNoeticConfigError,
  NoeticConfigError,
} from '../src/errors/noetic-config-error';

describe('NoeticConfigError', () => {
  it('links docsUrl to the lower-case anchor of its code by default', () => {
    const error = new NoeticConfigError({
      code: 'NO_LLM_PROVIDER',
      message: 'No provider.',
      hint: 'Set a key.',
    });
    expect(isNoeticConfigError(error)).toBe(true);
    expect(error.docsUrl).toBe('https://noetic.tools/docs/framework/errors#no_llm_provider');
  });

  it('configErrorDocsUrl lower-cases the code into the anchor', () => {
    expect(configErrorDocsUrl('EMPTY_STEP_ID')).toBe(
      'https://noetic.tools/docs/framework/errors#empty_step_id',
    );
  });
});
