import { expect, test } from 'bun:test';
import { errorMessage } from '../../src/util/error-message';

test.each([
  [
    'stopped',
    'stopped',
  ],
  [
    null,
    'null',
  ],
  [
    {},
    'Unknown error',
  ],
  [
    {
      message: 5,
    },
    'Unknown error',
  ],
  [
    {
      data: {
        message: 'detail',
      },
    },
    'detail',
  ],
  [
    {
      message: 'same',
      data: {
        message: 'same',
      },
    },
    'same',
  ],
  [
    {
      message: 'outer',
      data: {
        message: 42,
      },
    },
    'outer',
  ],
  [
    new Error('broken'),
    'broken',
  ],
])('renders error messages without assuming Error instances', (error, message) => {
  expect(errorMessage(error)).toBe(message);
});
