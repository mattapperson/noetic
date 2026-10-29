import { describe, expect, it } from 'bun:test';
import { profileFieldOf } from '@noetic-tools/types';
import {
  formatVisualSummary,
  PROFILE_NAME,
  SCREEN_FRAME_KIND,
  ScreenCaptureSchema,
  screen,
  VISUAL_SUMMARY,
} from '../src/index';
import { blobOf, checkOperation, flagsOf, receiptOf, refOf } from './_helpers';

const frame = refOf('screen.frame');
const done = {
  receipt: receiptOf(),
};
const capture = {
  frame,
  image: blobOf('image/png'),
  width: 1280,
  height: 720,
};

describe('screen@1 profile', () => {
  it('has its identity and stands alone', () => {
    expect(PROFILE_NAME).toBe('screen');
    expect(screen.id).toBe('screen@1');
    expect(screen.parents).toEqual({});
    expect(screen.definition.determinism.observation).toBe('sampled');
  });

  it('declares every catalog operation with its flags', () => {
    expect(Object.keys(screen.operations).sort()).toEqual([
      'screen.capture',
      'screen.drag',
      'screen.tap',
    ]);
    expect(flagsOf(screen, 'screen.capture')).toEqual({
      sense: 'visual',
    });
    expect(flagsOf(screen, 'screen.tap')).toEqual({
      effects: true,
    });
    expect(flagsOf(screen, 'screen.drag')).toEqual({
      effects: true,
      optional: true,
    });
  });

  it('screen.capture returns a frame and an image', () => {
    checkOperation(screen, 'screen.capture', {
      input: {
        within: refOf('app.window'),
        region: {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      },
      badInput: {
        region: {
          x: -1,
          y: 0,
          width: 10,
          height: 10,
        },
      },
      output: capture,
      badOutput: {
        ...capture,
        image: blobOf('application/pdf'),
      },
    });
    expect(screen.operations['screen.capture']?.input.safeParse({}).success).toBe(true);
    expect(profileFieldOf(ScreenCaptureSchema.shape.frame)).toEqual({
      kind: 'ref',
      refKind: SCREEN_FRAME_KIND,
      volatile: true,
      public: false,
    });
    expect(profileFieldOf(ScreenCaptureSchema.shape.image)).toEqual({
      kind: 'blob',
      mimeTypes: [
        'image/*',
      ],
    });
  });

  it('screen.tap carries its frame', () => {
    checkOperation(screen, 'screen.tap', {
      input: {
        frame,
        x: 10,
        y: 20,
        count: 2,
      },
      badInput: {
        x: 10,
        y: 20,
      },
      output: done,
      badOutput: {},
    });
    expect(
      screen.operations['screen.tap']?.input.safeParse({
        frame,
        x: 1.5,
        y: 2,
      }).success,
    ).toBe(false);
  });

  it('screen.drag needs a path of at least two points', () => {
    checkOperation(screen, 'screen.drag', {
      input: {
        frame,
        path: [
          {
            x: 0,
            y: 0,
          },
          {
            x: 10,
            y: 10,
            dtMs: 16,
          },
        ],
      },
      badInput: {
        frame,
        path: [
          {
            x: 0,
            y: 0,
          },
        ],
      },
      output: done,
      badOutput: {},
    });
  });

  it('screen.current is looked at on request', () => {
    const current = screen.reads['screen.current'];
    expect(current?.look).toBe('ask');
    expect(current?.sense).toBe('visual');
    expect(current?.schema.safeParse(capture).success).toBe(true);
  });

  it('the visual summary is capture', () => {
    expect(VISUAL_SUMMARY).toBe('capture');
    expect(formatVisualSummary()).toBe('capture');
  });
});
