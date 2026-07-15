'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import { PhoneShot } from '@/components/landing/phone-shot';
import type { ReactNode } from 'react';

interface FeatureTile {
  name: string;
  chip: string;
  detail: string;
}

const FEATURES: FeatureTile[] = [
  {
    name: 'Automations',
    chip: 'describe → plan → enable',
    detail:
      'Type what you want in plain language — "every weekday at 9, triage new issues" — and the platform drafts the trigger. Cron schedules and connector events, unified.',
  },
  {
    name: 'Connectors',
    chip: 'slack · discord · teams · +7',
    detail:
      'Agents answer where the conversation happens: Slack, Discord, Teams, Telegram, WhatsApp, Messenger, GitHub, Linear, Google Chat, Twilio. Bring your own app or use ours.',
  },
  {
    name: 'Generative UI',
    chip: 'forms · tables · charts · maps',
    detail:
      'Agents render live interactive UI — not walls of text. One OpenUI document renders natively on web, in the terminal, and in the iOS and macOS apps.',
  },
  {
    name: 'Memory layers',
    chip: 'editable · server-side',
    detail:
      'History windows, working memory, plans, steering rules, temporal facts. Live token usage per layer, and you can edit what the agent remembers mid-session.',
  },
  {
    name: 'Projects & environments',
    chip: 'apt · repos · env · services',
    detail:
      'Declare the machine your agents work on: packages, CLIs, private git repos, seeded files, env vars, background services. Provisioned once, warm forever.',
  },
  {
    name: 'Sub-agents',
    chip: 'agents calling agents',
    detail:
      'Any agent can delegate to another as a tool — same session, same workspace, per-run allow-list. Deep Research ships built in.',
  },
  {
    name: 'Local tools SDK',
    chip: 'your code, their cloud',
    detail:
      'Declare a tool in a few lines of TypeScript on any machine you own, and cloud agents can call it — routed to the right machine, results streamed back into the run.',
  },
  {
    name: 'Secrets & permissions',
    chip: 'write-only vaults',
    detail:
      'Org-scoped vaults where values go in but never come back out — resolved just-in-time inside the platform. Orgs, roles, device keys, and an audit log underneath.',
  },
  {
    name: 'White-label',
    chip: 'your brand, your plans',
    detail:
      'Resell agents under your own domains and branding, with per-customer plans, hard limits, and metering. You bill your customers; Noetic meters the usage.',
  },
];

export function PlatformInside(): ReactNode {
  return (
    <section className="code-section">
      <div
        style={{
          display: 'grid',
          gap: '16px',
          marginBottom: '40px',
          maxWidth: '780px',
        }}
      >
        <span className="code-section-eyebrow">{'02 / inside the box'}</span>
        <h2 className="code-display-headline">
          Batteries <em>very much</em> included.
        </h2>
        <p
          style={{
            fontSize: '15px',
            color: 'var(--color-tui-secondary)',
            margin: 0,
            lineHeight: 1.65,
          }}
        >
          Everything an agent needs to be useful in the real world — the parts you would otherwise
          spend a quarter wiring together.
        </p>
      </div>

      <div
        className="patterns-grid"
        style={{
          display: 'grid',
          gap: '4px',
          marginBottom: '32px',
        }}
      >
        {FEATURES.map((feature, i) => (
          <motion.div
            key={feature.name}
            initial={{
              opacity: 0,
              y: 10,
            }}
            whileInView={{
              opacity: 1,
              y: 0,
            }}
            transition={{
              delay: (i % 3) * 0.06,
              duration: 0.3,
            }}
            viewport={{
              once: true,
            }}
            style={{
              background: 'var(--color-tui-surface)',
              border: '1px solid var(--color-tui-border)',
              padding: '28px 24px 24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '17px',
                  fontWeight: 700,
                  color: 'var(--color-tui-fg)',
                  letterSpacing: '-0.01em',
                  marginBottom: '4px',
                }}
              >
                {feature.name}
              </div>
              <code
                style={{
                  fontSize: '11px',
                  color: 'var(--color-tui-cyan)',
                  letterSpacing: '0.04em',
                }}
              >
                {feature.chip}
              </code>
            </div>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--color-tui-muted)',
                margin: 0,
                lineHeight: 1.65,
              }}
            >
              {feature.detail}
            </p>
          </motion.div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          gap: '32px',
          alignItems: 'center',
          flexWrap: 'wrap',
          border: '1px solid var(--color-tui-border)',
          background: 'var(--color-tui-surface)',
          padding: '32px 28px',
          marginBottom: '32px',
        }}
      >
        <div
          style={{
            flex: '1 1 320px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <span
            style={{
              fontSize: '11px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-tui-green)',
              fontWeight: 700,
            }}
          >
            native, not a webview
          </span>
          <h3
            style={{
              margin: 0,
              fontSize: '26px',
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: 'var(--color-tui-fg)',
            }}
          >
            The whole platform, in your pocket.
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: '14px',
              color: 'var(--color-tui-secondary)',
              lineHeight: 1.65,
              maxWidth: '420px',
            }}
          >
            Chat, projects, agents, automations, and secrets ship in native iOS and macOS apps —
            the same live sessions as the web dashboard and the terminal. Describe an automation
            in a sentence from your phone; the platform drafts the plan.
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            gap: '20px',
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          <PhoneShot
            src="/screenshots/ios-drawer.png"
            alt="Noetic iOS navigation — Chat, Projects, Apps, Agents, Automations, Secrets, and recent sessions"
            caption="every surface"
            width={230}
          />
          <PhoneShot
            src="/screenshots/ios-automation.png"
            alt="Creating an automation on iOS by describing it in plain language"
            caption="describe-first automations"
            width={230}
          />
        </div>
      </div>

      <p
        style={{
          padding: '14px 16px',
          border: '1px solid var(--color-tui-border)',
          fontSize: '13px',
          color: 'var(--color-tui-secondary)',
          background: 'var(--color-tui-surface)',
          margin: 0,
          lineHeight: 1.6,
        }}
      >
        Writing software? The platform's flagship agent is{' '}
        <Link
          href="/code"
          style={{
            color: 'var(--color-tui-green)',
            textDecoration: 'none',
            fontWeight: 700,
          }}
        >
          Noetic Code
        </Link>{' '}
        — the coding agent in your terminal, on your Mac, and in your pocket.
      </p>
    </section>
  );
}
