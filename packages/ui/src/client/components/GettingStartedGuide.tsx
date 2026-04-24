/**
 * Getting started guide shown when no agents are discovered
 */

import type React from 'react';

const codeBlockStyle: React.CSSProperties = {
  backgroundColor: 'var(--noetic-code-bg, rgba(0,0,0,0.15))',
  borderRadius: '4px',
  padding: '10px 12px',
  fontSize: '11px',
  fontFamily: 'monospace',
  overflowX: 'auto',
  color: 'var(--noetic-text)',
  lineHeight: 1.5,
  whiteSpace: 'pre',
};

const sectionStyle: React.CSSProperties = {
  marginBottom: '16px',
};

const headingStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--noetic-text)',
  margin: '0 0 6px 0',
};

const textStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--noetic-text-muted)',
  margin: '0 0 8px 0',
  lineHeight: 1.5,
};

const GettingStartedGuide: React.FC = () => {
  return (
    <div
      style={{
        padding: '16px',
        color: 'var(--noetic-text-muted)',
        fontSize: '12px',
      }}
    >
      <h2
        style={{
          fontSize: '14px',
          fontWeight: 600,
          color: 'var(--noetic-text)',
          margin: '0 0 4px 0',
        }}
      >
        Getting Started
      </h2>
      <p
        style={{
          ...textStyle,
          marginBottom: '16px',
        }}
      >
        No agents discovered yet. Create an agent to get started.
      </p>

      <div style={sectionStyle}>
        <h3 style={headingStyle}>1. Create an agent file</h3>
        <p style={textStyle}>
          Name it <code>*.agent.ts</code>, <code>*.noetic.ts</code>, or place it in an{' '}
          <code>agents/</code> directory.
        </p>
        <pre style={codeBlockStyle}>
          {`import { loop, step, until } from '@noetic/core';

export const agent = loop(
  step.llm({
    model: 'gpt-4o',
    instructions: 'You are a helpful assistant.',
  }),
  until.noToolCalls(),
);`}
        </pre>
      </div>

      <div style={sectionStyle}>
        <h3 style={headingStyle}>2. Run with the harness</h3>
        <pre style={codeBlockStyle}>
          {`import { AgentHarness } from '@noetic/core/runtime';

const harness = new AgentHarness({
  name: 'my-agent',
  params: {},
});
const ctx = harness.createContext();
await harness.run(agent, 'Hello!', ctx);`}
        </pre>
      </div>

      <div style={sectionStyle}>
        <h3 style={headingStyle}>3. Discovery patterns</h3>
        <p style={textStyle}>The UI auto-discovers agents matching these patterns:</p>
        <ul
          style={{
            ...textStyle,
            margin: 0,
            paddingLeft: '16px',
          }}
        >
          <li>
            <code>**/*.agent.ts</code>
          </li>
          <li>
            <code>{'**/agents/**/*.ts'}</code>
          </li>
          <li>
            <code>**/*.noetic.ts</code>
          </li>
        </ul>
      </div>
    </div>
  );
};

export default GettingStartedGuide;
