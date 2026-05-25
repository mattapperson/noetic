/**
 * Tests for the summary renderer registry.
 *
 * The registry uses self-registering side-effect imports which create a circular
 * dependency (registry -> DefaultSummary -> registry). To avoid the ESM TDZ
 * issue in bun test, we import one of the summary modules first so the module
 * graph resolves in the correct order.
 */

import { describe, expect, it } from 'bun:test';
import type { SummaryRenderer } from '../../../../../src/client/components/inspector/summaries/registry';
import {
  clearSummaryRenderers,
  getSummaryRenderer,
  registerBuiltInSummaries,
  registerSummaryRenderer,
  unregisterSummaryRenderer,
} from '../../../../../src/client/components/inspector/summaries/registry';

//#region Helpers

/** Dummy renderer for testing */
const DummyRenderer: SummaryRenderer = () => null;

/** Another dummy renderer */
const AnotherRenderer: SummaryRenderer = () => null;

//#endregion

describe('Summary Renderer Registry', () => {
  describe('built-in renderers', () => {
    it('has llm renderer registered', () => {
      const renderer = getSummaryRenderer('llm');
      expect(renderer).toBeDefined();
      expect(typeof renderer).toBe('function');
    });

    it('has tool renderer registered', () => {
      const renderer = getSummaryRenderer('tool');
      expect(renderer).toBeDefined();
      expect(typeof renderer).toBe('function');
    });

    it('has branch renderer registered', () => {
      const renderer = getSummaryRenderer('branch');
      expect(renderer).toBeDefined();
      expect(typeof renderer).toBe('function');
    });

    it('has fork renderer registered', () => {
      const renderer = getSummaryRenderer('fork');
      expect(renderer).toBeDefined();
      expect(typeof renderer).toBe('function');
    });

    it('has loop renderer registered', () => {
      const renderer = getSummaryRenderer('loop');
      expect(renderer).toBeDefined();
      expect(typeof renderer).toBe('function');
    });

    it('has every renderer registered', () => {
      const renderer = getSummaryRenderer('every');
      expect(renderer).toBeDefined();
      expect(typeof renderer).toBe('function');
    });

    it('every renderer is distinct from loop renderer (not the default fallback)', () => {
      const everyRenderer = getSummaryRenderer('every');
      const loopRenderer = getSummaryRenderer('loop');
      const defaultRenderer = getSummaryRenderer('default');
      expect(everyRenderer).not.toBe(loopRenderer);
      expect(everyRenderer).not.toBe(defaultRenderer);
    });

    it('has spawn renderer registered', () => {
      const renderer = getSummaryRenderer('spawn');
      expect(renderer).toBeDefined();
      expect(typeof renderer).toBe('function');
    });

    it('has default renderer registered', () => {
      const renderer = getSummaryRenderer('default');
      expect(renderer).toBeDefined();
      expect(typeof renderer).toBe('function');
    });

    it('each built-in kind returns a distinct renderer (not FallbackSummary)', () => {
      const llm = getSummaryRenderer('llm');
      const tool = getSummaryRenderer('tool');
      expect(llm).not.toBe(tool);
    });
  });

  describe('registerSummaryRenderer', () => {
    it('registers a renderer for a kind', () => {
      registerSummaryRenderer('test-kind', DummyRenderer);
      const retrieved = getSummaryRenderer('test-kind');
      expect(retrieved).toBe(DummyRenderer);
      unregisterSummaryRenderer('test-kind');
    });

    it('overwrites a previously registered renderer', () => {
      registerSummaryRenderer('test-kind', DummyRenderer);
      registerSummaryRenderer('test-kind', AnotherRenderer);
      const retrieved = getSummaryRenderer('test-kind');
      expect(retrieved).toBe(AnotherRenderer);
      unregisterSummaryRenderer('test-kind');
    });
  });

  describe('getSummaryRenderer', () => {
    it('returns the registered renderer for a known kind', () => {
      registerSummaryRenderer('test-kind', DummyRenderer);
      expect(getSummaryRenderer('test-kind')).toBe(DummyRenderer);
      unregisterSummaryRenderer('test-kind');
    });

    it('returns DefaultSummary for an unregistered kind', () => {
      const defaultRenderer = getSummaryRenderer('default');
      const fallback = getSummaryRenderer('nonexistent-kind-xyz');
      // When 'default' is registered, unregistered kinds get the default renderer
      expect(fallback).toBe(defaultRenderer);
    });

    it('returns FallbackSummary after clearSummaryRenderers without crashing', () => {
      clearSummaryRenderers();
      try {
        const fallback = getSummaryRenderer('anything');
        expect(fallback).toBeDefined();
        expect(typeof fallback).toBe('function');
      } finally {
        registerBuiltInSummaries();
      }
    });
  });

  describe('unregisterSummaryRenderer', () => {
    it('removes a registered renderer', () => {
      registerSummaryRenderer('test-kind', DummyRenderer);
      expect(getSummaryRenderer('test-kind')).toBe(DummyRenderer);

      unregisterSummaryRenderer('test-kind');
      const defaultRenderer = getSummaryRenderer('default');
      expect(getSummaryRenderer('test-kind')).toBe(defaultRenderer);
    });

    it('is a no-op for an unregistered kind', () => {
      // Should not throw
      unregisterSummaryRenderer('never-registered');
    });
  });

  describe('clearSummaryRenderers', () => {
    it('removes all renderers including built-ins', () => {
      clearSummaryRenderers();
      try {
        // All built-in kinds should now return the same FallbackSummary
        const llmRenderer = getSummaryRenderer('llm');
        const toolRenderer = getSummaryRenderer('tool');
        const defaultRenderer = getSummaryRenderer('default');
        expect(llmRenderer).toBe(toolRenderer);
        expect(llmRenderer).toBe(defaultRenderer);
      } finally {
        registerBuiltInSummaries();
      }
    });
  });
});
