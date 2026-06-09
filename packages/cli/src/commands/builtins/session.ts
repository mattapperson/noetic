/**
 * /session command — print a metadata report for the current session.
 */

import type { Command, LocalCommandCall, SessionSnapshot } from '../types.js';

function formatUsage(snapshot: SessionSnapshot): string {
  const { inputTokens, outputTokens, cachedTokens } = snapshot.cumulativeUsage;
  const base = `in ${inputTokens} · out ${outputTokens}`;
  return cachedTokens > 0 ? `${base} · cached ${cachedTokens}` : base;
}

const call: LocalCommandCall = async (_args, ctx) => {
  const s = ctx.sessionSnapshot;
  const lines = [
    `Session ${s.sessionId}`,
    `  cwd:           ${s.cwd}${s.effectiveCwd !== s.cwd ? `  (now: ${s.effectiveCwd})` : ''}`,
    `  model:         ${s.model}`,
    `  created:       ${s.createdAt}`,
    `  messages:      ${s.messageCount}`,
    `  tokens:        ${formatUsage(s)}`,
    `  cost:          $${s.cumulativeCost.toFixed(4)}`,
    `  title:         ${s.customTitle ?? '(none)'}`,
    `  tag:           ${s.tag ?? '(none)'}`,
    `  persistence:   ${s.persistenceEnabled ? 'on' : 'off'}`,
  ];
  return {
    type: 'text',
    value: lines.join('\n'),
  };
};

export const session: Command = {
  type: 'local',
  name: 'session',
  description: 'Show metadata for the current session',
  load: async () => ({
    call,
  }),
};
