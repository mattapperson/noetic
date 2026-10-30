import { describe, expect, it } from 'bun:test';
import { channelDescriptor, channelDescriptors } from '../src/descriptors';

describe('sense descriptors', () => {
  it('clamps a named sense declared more trustworthy than OVP allows (OVP-CHAN-1)', () => {
    expect(
      channelDescriptor('ui', {
        independence: 'independent',
        grade: 'consequence',
      }),
    ).toEqual({
      id: 'ui',
      independence: 'actuation-derived',
      grade: 'presence',
    });
  });

  it('keeps a named sense declared less trustworthy, with its note', () => {
    expect(
      channelDescriptor('net', {
        independence: 'actuation-derived',
        grade: 'context',
        note: 'proxied',
      }),
    ).toEqual({
      id: 'net',
      independence: 'actuation-derived',
      grade: 'context',
      note: 'proxied',
    });
  });

  it('takes an x- sense as declared, defaults a named sense, and drops an undeclared x- sense', () => {
    expect(
      channelDescriptor('x-orders-db', {
        independence: 'independent',
        grade: 'consequence',
        note: 'primary db',
      }),
    ).toEqual({
      id: 'x-orders-db',
      independence: 'independent',
      grade: 'consequence',
      note: 'primary db',
    });
    expect(channelDescriptor('log', undefined)).toEqual({
      id: 'log',
      independence: 'independent',
      grade: 'context',
    });
    expect(channelDescriptor('x-nothing', undefined)).toBeUndefined();
    expect(
      channelDescriptors({
        net: {
          independence: 'independent',
          grade: 'consequence',
        },
      }).map((d) => d.id),
    ).toEqual([
      'net',
    ]);
  });
});
