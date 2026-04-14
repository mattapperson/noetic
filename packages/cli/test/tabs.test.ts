/**
 * Unit tests for the pure helpers behind <Tabs>. Rendering/useInput behavior
 * is covered via pilotty-driven e2e.
 */

import { describe, expect, test } from 'bun:test';
import { createElement, type ReactElement } from 'react';
import { Tab, type TabProps } from '../src/tui/components/tabs/tab.js';
import {
  collectTabs,
  resolveDefaultIndex,
  resolveSelectedIndex,
} from '../src/tui/components/tabs/tabs.js';

//#region Helpers

function makeTab(title: string, id?: string): ReactElement<TabProps> {
  return createElement(Tab, {
    title,
    id,
  });
}

//#endregion

describe('collectTabs', () => {
  test('empty children yields empty list', () => {
    expect(collectTabs(null)).toEqual([]);
    expect(collectTabs([])).toEqual([]);
  });

  test('collects Tab children with title as id when id is omitted', () => {
    const metas = collectTabs([
      makeTab('Overview'),
      makeTab('planMemory', 'plan'),
    ]);
    expect(metas).toEqual([
      {
        id: 'Overview',
        title: 'Overview',
      },
      {
        id: 'plan',
        title: 'planMemory',
      },
    ]);
  });

  test('ignores non-Tab children', () => {
    const metas = collectTabs([
      makeTab('A'),
      createElement('span', null, 'not a tab'),
      'raw string',
      makeTab('B'),
    ]);
    expect(metas.map((m) => m.id)).toEqual([
      'A',
      'B',
    ]);
  });
});

describe('resolveDefaultIndex', () => {
  const tabs = [
    {
      id: 'a',
      title: 'A',
    },
    {
      id: 'b',
      title: 'B',
    },
    {
      id: 'c',
      title: 'C',
    },
  ];

  test('returns 0 when no default provided', () => {
    expect(resolveDefaultIndex(tabs, undefined)).toBe(0);
  });

  test('returns 0 when default id is not found', () => {
    expect(resolveDefaultIndex(tabs, 'missing')).toBe(0);
  });

  test('returns matching index when default id is found', () => {
    expect(resolveDefaultIndex(tabs, 'b')).toBe(1);
    expect(resolveDefaultIndex(tabs, 'c')).toBe(2);
  });
});

describe('resolveSelectedIndex', () => {
  const tabs = [
    {
      id: 'a',
      title: 'A',
    },
    {
      id: 'b',
      title: 'B',
    },
  ];

  test('uncontrolled clamps internal to valid range', () => {
    expect(resolveSelectedIndex(tabs, undefined, 0)).toBe(0);
    expect(resolveSelectedIndex(tabs, undefined, 1)).toBe(1);
    expect(resolveSelectedIndex(tabs, undefined, 99)).toBe(1);
  });

  test('uncontrolled with empty tabs returns 0', () => {
    expect(resolveSelectedIndex([], undefined, 5)).toBe(0);
  });

  test('controlled honors the controlled id', () => {
    expect(resolveSelectedIndex(tabs, 'a', 99)).toBe(0);
    expect(resolveSelectedIndex(tabs, 'b', 0)).toBe(1);
  });

  test('controlled falls back to 0 when id is not in tabs', () => {
    expect(resolveSelectedIndex(tabs, 'missing', 1)).toBe(0);
  });
});
