import { describe, expect, it } from 'bun:test';
import { cosineSimilarity } from '../../src/conditions/cosine-similarity';

describe('cosineSimilarity', () => {
  it('identical vectors return 1', () => {
    const v = [
      1,
      2,
      3,
    ];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it('orthogonal vectors return 0', () => {
    expect(
      cosineSimilarity(
        [
          1,
          0,
        ],
        [
          0,
          1,
        ],
      ),
    ).toBeCloseTo(0, 10);
  });

  it('opposite vectors return -1', () => {
    expect(
      cosineSimilarity(
        [
          1,
          0,
        ],
        [
          -1,
          0,
        ],
      ),
    ).toBeCloseTo(-1, 10);
  });

  it('dimension mismatch throws', () => {
    expect(() =>
      cosineSimilarity(
        [
          1,
          2,
        ],
        [
          1,
          2,
          3,
        ],
      ),
    ).toThrow('Dimension mismatch');
  });

  it('zero vectors return 0', () => {
    expect(
      cosineSimilarity(
        [
          0,
          0,
        ],
        [
          0,
          0,
        ],
      ),
    ).toBe(0);
  });

  it('one zero vector returns 0', () => {
    expect(
      cosineSimilarity(
        [
          0,
          0,
        ],
        [
          1,
          2,
        ],
      ),
    ).toBe(0);
  });

  it('similar vectors return high similarity', () => {
    const a = [
      1,
      2,
      3,
    ];
    const b = [
      1.1,
      2.1,
      3.1,
    ];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.99);
    expect(sim).toBeLessThanOrEqual(1);
  });
});
