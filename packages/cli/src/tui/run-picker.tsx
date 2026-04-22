/**
 * Render the resume picker and resolve with the selected SessionFile, or
 * null if the user cancels. Used by `cli.ts` when `--resume` is passed
 * without an id and from the `/resume` slash command (Phase 6).
 */

import { render } from 'ink';

import type { SessionFile } from '../sessions/types.js';
import { InkProvider } from './components/index.js';
import { ResumeScreen } from './components/resume/resume-screen.js';

export async function runPicker(cwd: string): Promise<SessionFile | null> {
  return new Promise<SessionFile | null>((resolve) => {
    const instance = render(
      <InkProvider>
        <ResumeScreen
          cwd={cwd}
          onSelect={(file) => {
            instance.unmount();
            resolve(file);
          }}
          onCancel={() => {
            instance.unmount();
            resolve(null);
          }}
        />
      </InkProvider>,
    );
  });
}
