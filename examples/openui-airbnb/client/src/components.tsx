/**
 * The styled Annapolis component library — the client half of the vocabulary the
 * agent renders, expressed with react-lang's `defineComponent`/`createLibrary`.
 *
 * Each component's Zod schema lists its props in the SAME order the server
 * library declares them (OpenUI Lang args are positional, so order is the
 * contract). Renderers are plain React FCs: container children arrive as node
 * arrays and are materialized with `renderNode`; `Action([...])` props arrive as
 * evaluated ActionPlans and are dispatched through `useTriggerAction`, which
 * drives the next agent turn (via the Renderer's `onAction`) and applies any
 * `@Set` steps to react-lang's reactive store.
 *
 * The intent-adaptive piece is `ListingCard.highlight` + `StatGrid`: the agent
 * decides what fact to feature, and these components render it prominently.
 */

import type { ActionPlan } from '@openuidev/react-lang';
import { createLibrary, defineComponent, useTriggerAction } from '@openuidev/react-lang';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { z } from 'zod';

/** Narrow an action-typed prop (declared `z.any()`) to an evaluated ActionPlan. */
function isActionPlan(value: unknown): value is ActionPlan {
  return (
    typeof value === 'object' && value !== null && 'steps' in value && Array.isArray(value.steps)
  );
}

//#region Azulejo-style tile (deterministic art per listing)

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) % 360;
  }
  return h;
}

function Tile({ seed }: { seed: string }): ReactNode {
  const hue = hashHue(seed);
  const hueB = (hue + 40) % 360;
  const style = {
    backgroundColor: `hsl(${hue} 62% 72%)`,
    backgroundImage: [
      `linear-gradient(135deg, hsl(${hue} 66% 68%), hsl(${hueB} 58% 60%))`,
      'repeating-linear-gradient(45deg, hsla(0 0% 100% / 0.16) 0 8px, transparent 8px 22px)',
      'repeating-linear-gradient(-45deg, hsla(220 40% 20% / 0.10) 0 8px, transparent 8px 22px)',
    ].join(','),
  };
  return <div className="tile" style={style} aria-hidden="true" />;
}

//#endregion

//#region Components

const Page = defineComponent({
  name: 'Page',
  description: 'Top-level stays surface: wordmark, title, optional subtitle, and body children.',
  props: z.object({
    title: z.string().optional(),
    subtitle: z.string().optional(),
    children: z.array(z.any()).optional(),
  }),
  component: ({ props, renderNode }) => {
    const subtitle = props.subtitle ?? '';
    return (
      <div className="page">
        <header className="topbar">
          <span className="wordmark">Chesapeake</span>
          <span className="topbar-sub">{props.title ?? 'Stays'}</span>
        </header>
        <main className="page-body">
          {subtitle.length > 0 && <p className="subtitle">{subtitle}</p>}
          {renderNode(props.children)}
        </main>
      </div>
    );
  },
});

const SearchBar = defineComponent({
  name: 'SearchBar',
  description:
    'Natural-language intent box (with a guests stepper) whose submit reshapes the whole screen.',
  props: z.object({
    location: z.string().optional(),
    guests: z.number().optional(),
  }),
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const [loc, setLoc] = useState(props.location ?? 'Annapolis');
    const [n, setN] = useState(props.guests ?? 2);
    // The field is a natural-language intent box: whatever you ask reshapes the
    // whole screen. Guests ride along so the agent can size the results.
    const search = (): void => {
      void triggerAction(`${loc.trim() || 'Annapolis stays'} — for ${n} guests`);
    };
    return (
      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <label className="field field-grow">
          <span className="field-label">Ask for anything</span>
          <input
            className="field-input"
            value={loc}
            onChange={(e) => setLoc(e.target.value)}
            placeholder="Try: homes with the most bedrooms"
          />
        </label>
        <div className="field-divider" />
        <label className="field">
          <span className="field-label">Guests</span>
          <div className="stepper">
            <button
              type="button"
              className="stepper-btn"
              onClick={() => setN(Math.max(1, n - 1))}
              aria-label="Fewer guests"
            >
              −
            </button>
            <span className="stepper-value">{n}</span>
            <button
              type="button"
              className="stepper-btn"
              onClick={() => setN(n + 1)}
              aria-label="More guests"
            >
              +
            </button>
          </div>
        </label>
        <button type="submit" className="search-btn" aria-label="Search">
          Search
        </button>
      </form>
    );
  },
});

const SortBar = defineComponent({
  name: 'SortBar',
  description: 'Row of sort chips. Renders nothing until at least one chip streams in.',
  props: z.object({
    children: z.array(z.any()).optional(),
  }),
  component: ({ props, renderNode }) => {
    const chips = props.children ?? [];
    if (chips.length === 0) {
      return null;
    }
    return (
      <div className="sortbar">
        <span className="sortbar-label">Sort</span>
        {renderNode(chips)}
      </div>
    );
  },
});

const SortChip = defineComponent({
  name: 'SortChip',
  description: 'A sort option. `active` highlights the current sort; pressing runs its Action.',
  props: z.object({
    label: z.string().optional(),
    active: z.boolean().optional(),
    onPress: z.any().optional(),
  }),
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const label = props.label ?? 'Sort';
    const active = props.active === true;
    const action = isActionPlan(props.onPress) ? props.onPress : undefined;
    return (
      <button
        type="button"
        className={`sortchip${active ? ' sortchip-active' : ''}`}
        aria-pressed={active}
        onClick={action ? () => void triggerAction(label, undefined, action) : undefined}
      >
        {label}
      </button>
    );
  },
});

const ListingGrid = defineComponent({
  name: 'ListingGrid',
  description: 'Responsive grid of ListingCards.',
  props: z.object({
    children: z.array(z.any()).optional(),
  }),
  component: ({ props, renderNode }) => <div className="grid">{renderNode(props.children)}</div>,
});

const ListingCard = defineComponent({
  name: 'ListingCard',
  description:
    'A stay: tile art, optional Superhost badge, an agent-chosen highlight fact, rating and price. ' +
    'When it carries an onSelect Action it becomes clickable and drives the next turn.',
  props: z.object({
    title: z.string().optional(),
    location: z.string().optional(),
    price: z.number().optional(),
    rating: z.number().optional(),
    image: z.string().optional(),
    superhost: z.boolean().optional(),
    highlight: z.string().optional(),
    onSelect: z.any().optional(),
  }),
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const title = props.title ?? 'Stay';
    const highlight = props.highlight ?? '';
    const action = isActionPlan(props.onSelect) ? props.onSelect : undefined;
    const select = action ? () => void triggerAction(title, undefined, action) : undefined;
    return (
      <article
        className={`card${select ? ' card-clickable' : ''}`}
        onClick={select}
        onKeyDown={
          select
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  select();
                }
              }
            : undefined
        }
        role={select ? 'button' : undefined}
        tabIndex={select ? 0 : undefined}
      >
        <div className="card-media">
          <Tile seed={props.image ?? title} />
          {props.superhost === true && <span className="badge">Superhost</span>}
          {highlight.length > 0 && <span className="highlight">{highlight}</span>}
        </div>
        <div className="card-body">
          <div className="card-row">
            <h3 className="card-title">{title}</h3>
            <span className="rating">
              <span className="star">★</span>
              {(props.rating ?? 0).toFixed(2)}
            </span>
          </div>
          <p className="card-location">{props.location ?? ''}</p>
          <p className="card-price">
            <strong>${props.price ?? 0}</strong> <span className="muted">night</span>
          </p>
        </div>
      </article>
    );
  },
});

const StatGrid = defineComponent({
  name: 'StatGrid',
  description: 'Grid of labelled stats. The first stat is foregrounded as the featured fact.',
  props: z.object({
    stats: z
      .array(
        z.object({
          label: z.string().optional(),
          value: z.any(),
        }),
      )
      .optional(),
  }),
  component: ({ props }) => {
    const stats = props.stats ?? [];
    if (stats.length === 0) {
      return null;
    }
    return (
      <div className="statgrid">
        {stats.map((s, i) => (
          <div className="stat" key={s.label ?? i}>
            <span className="stat-value">{String(s.value ?? '')}</span>
            <span className="stat-label">{s.label ?? ''}</span>
          </div>
        ))}
      </div>
    );
  },
});

const PriceBreakdown = defineComponent({
  name: 'PriceBreakdown',
  description: 'Nightly × nights + cleaning fee, with a computed total.',
  props: z.object({
    nightly: z.number().optional(),
    nights: z.number().optional(),
    cleaning: z.number().optional(),
    total: z.number().optional(),
  }),
  component: ({ props }) => {
    const nightly = props.nightly ?? 0;
    const nightsN = props.nights ?? 1;
    const cleaning = props.cleaning ?? 0;
    const total = props.total ?? nightly * nightsN + cleaning;
    return (
      <div className="price">
        <div className="price-row">
          <span>
            ${nightly} × {nightsN} nights
          </span>
          <span>${nightly * nightsN}</span>
        </div>
        <div className="price-row">
          <span>Cleaning fee</span>
          <span>${cleaning}</span>
        </div>
        <div className="price-row price-total">
          <span>Total</span>
          <span>${total}</span>
        </div>
      </div>
    );
  },
});

const Heading = defineComponent({
  name: 'Heading',
  description: 'Section heading.',
  props: z.object({
    text: z.string().optional(),
  }),
  component: ({ props }) => <h2 className="heading">{props.text ?? ''}</h2>,
});

const Text = defineComponent({
  name: 'Text',
  description: 'A paragraph of muted body copy.',
  props: z.object({
    value: z.string().optional(),
  }),
  component: ({ props }) => <p className="text">{props.value ?? ''}</p>,
});

const Stack = defineComponent({
  name: 'Stack',
  description: 'Vertical stack of children.',
  props: z.object({
    children: z.array(z.any()).optional(),
  }),
  component: ({ props, renderNode }) => <div className="stack">{renderNode(props.children)}</div>,
});

const Button = defineComponent({
  name: 'Button',
  description: 'Primary action button. Pressing runs its Action (drives the next turn).',
  props: z.object({
    label: z.string().optional(),
    onPress: z.any().optional(),
  }),
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const label = props.label ?? 'Continue';
    const action = isActionPlan(props.onPress) ? props.onPress : undefined;
    return (
      <button
        type="button"
        className="button"
        onClick={action ? () => void triggerAction(label, undefined, action) : undefined}
      >
        {label}
      </button>
    );
  },
});

//#endregion

//#region Library (component order MUST match the server library declaration order)

export const airbnbLibrary = createLibrary({
  root: 'root',
  components: [
    Page,
    SearchBar,
    SortBar,
    SortChip,
    ListingGrid,
    ListingCard,
    StatGrid,
    PriceBreakdown,
    Heading,
    Text,
    Stack,
    Button,
  ],
});

//#endregion
