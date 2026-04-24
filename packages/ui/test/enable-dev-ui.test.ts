/**
 * Tests for enableDevUI() — the explicit opt-in entry point.
 *
 * Verifies:
 * - Module purity: importing step-extractors alone does not register built-ins
 * - enableDevUI() registers extractors and exporter factory
 * - disable() cleans up all registrations
 * - Idempotency: second call warns and is a no-op
 * - Re-enable after disable works
 */

import { afterEach, describe, expect, it, jest } from 'bun:test';
import { clearExporterFactory, getRegisteredExporter } from '@noetic/core';
import { enableDevUI } from '../src/runtime/enable';
import {
  clearStepDataExtractors,
  getRegisteredStepKinds,
  hasStepDataExtractor,
  resetBuiltinsGuard,
} from '../src/runtime/step-extractors';

afterEach(() => {
  clearStepDataExtractors();
  clearExporterFactory();
  resetBuiltinsGuard();
});

describe('enableDevUI', () => {
  describe('module purity', () => {
    it('importing step-extractors does not register built-in extractors', () => {
      expect(getRegisteredStepKinds()).toHaveLength(0);
    });

    it('importing step-extractors does not register an exporter factory', () => {
      expect(getRegisteredExporter()).toBeNull();
    });
  });

  describe('registration', () => {
    it('registers all 8 built-in step extractors', () => {
      enableDevUI();
      const kinds = getRegisteredStepKinds();
      expect(kinds).toContain('llm');
      expect(kinds).toContain('tool');
      expect(kinds).toContain('fork');
      expect(kinds).toContain('loop');
      expect(kinds).toContain('spawn');
      expect(kinds).toContain('branch');
      expect(kinds).toContain('run');
      expect(kinds).toContain('provide');
      expect(kinds).toHaveLength(8);
    });

    it('registers an exporter factory that produces NoeticUITraceExporter', () => {
      enableDevUI({
        port: 19999,
        host: '0.0.0.0',
      });
      const exporter = getRegisteredExporter();
      expect(exporter).not.toBeNull();
      exporter!.close();
    });
  });

  describe('disable()', () => {
    it('clears exporter factory and step extractors', () => {
      const handle = enableDevUI();
      expect(getRegisteredStepKinds().length).toBeGreaterThan(0);
      expect(getRegisteredExporter()).not.toBeNull();

      handle.disable();

      expect(getRegisteredStepKinds()).toHaveLength(0);
      expect(getRegisteredExporter()).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('second call warns and returns no-op disable', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const first = enableDevUI();
      const second = enableDevUI();

      expect(warnSpy).toHaveBeenCalledWith('[noetic-ui] enableDevUI() already called — ignoring.');

      second.disable();
      expect(hasStepDataExtractor('llm')).toBe(true);

      first.disable();
      expect(hasStepDataExtractor('llm')).toBe(false);

      warnSpy.mockRestore();
    });
  });

  describe('re-enable after disable', () => {
    it('enableDevUI() works again after disable() resets state', () => {
      const first = enableDevUI();
      first.disable();

      expect(getRegisteredStepKinds()).toHaveLength(0);

      const second = enableDevUI();
      expect(getRegisteredStepKinds()).toHaveLength(8);
      expect(getRegisteredExporter()).not.toBeNull();

      second.disable();
    });
  });
});
