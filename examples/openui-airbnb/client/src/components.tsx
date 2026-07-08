/**
 * The styled Annapolis component library — the client half of the vocabulary the
 * agent renders. Each entry mirrors the server library's prop *order* (OpenUI
 * Lang args are positional) and returns real, designed React. The renderer
 * resolves component names against REGISTRY.
 *
 * The intent-adaptive piece is `ListingCard.highlight` + `StatGrid`: the agent
 * decides what fact to feature, and these components render it prominently.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import type { ComponentSpec, RenderContext } from './types';

//#region Prop coercion (no `as` — narrow explicitly)

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function bool(value: unknown): boolean {
  return value === true;
}
function isVoidFn(value: unknown): value is () => void {
  return typeof value === 'function';
}
function fn(value: unknown): (() => void) | undefined {
  return isVoidFn(value) ? value : undefined;
}
function nodes(value: unknown): ReactNode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (v): v is ReactNode => v !== undefined && v !== null && typeof v !== 'function',
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

//#endregion

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

function Page(props: Record<string, unknown>): ReactNode {
  const subtitle = str(props.subtitle);
  return (
    <div className="page">
      <header className="topbar">
        <span className="wordmark">Chesapeake</span>
        <span className="topbar-sub">{str(props.title, 'Stays')}</span>
      </header>
      <main className="page-body">
        {subtitle.length > 0 && <p className="subtitle">{subtitle}</p>}
        {nodes(props.children)}
      </main>
    </div>
  );
}

function SearchBar(props: Record<string, unknown>, ctx: RenderContext): ReactNode {
  return (
    <SearchBarView
      location={str(props.location, 'Annapolis')}
      guests={num(props.guests, 2)}
      ctx={ctx}
    />
  );
}

function SearchBarView({
  location,
  guests,
  ctx,
}: {
  location: string;
  guests: number;
  ctx: RenderContext;
}): ReactNode {
  const [loc, setLoc] = useState(location);
  const [n, setN] = useState(guests);
  // The field is a natural-language intent box: whatever you ask reshapes the
  // whole screen. Guests ride along so the agent can size the results.
  const search = (): void => ctx.onIntent(`${loc.trim() || 'Annapolis stays'} — for ${n} guests`);
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
}

function SortBar(props: Record<string, unknown>): ReactNode {
  const chips = nodes(props.children);
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className="sortbar">
      <span className="sortbar-label">Sort</span>
      {chips}
    </div>
  );
}

function SortChip(props: Record<string, unknown>): ReactNode {
  const onPress = fn(props.onPress);
  const active = bool(props.active);
  return (
    <button
      type="button"
      className={`sortchip${active ? ' sortchip-active' : ''}`}
      aria-pressed={active}
      onClick={onPress}
    >
      {str(props.label, 'Sort')}
    </button>
  );
}

function ListingGrid(props: Record<string, unknown>): ReactNode {
  return <div className="grid">{nodes(props.children)}</div>;
}

function ListingCard(props: Record<string, unknown>): ReactNode {
  const onSelect = fn(props.onSelect);
  const title = str(props.title, 'Stay');
  const highlight = str(props.highlight);
  return (
    <article
      className={`card${onSelect ? ' card-clickable' : ''}`}
      onClick={onSelect}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
    >
      <div className="card-media">
        <Tile seed={str(props.image, title)} />
        {bool(props.superhost) && <span className="badge">Superhost</span>}
        {highlight.length > 0 && <span className="highlight">{highlight}</span>}
      </div>
      <div className="card-body">
        <div className="card-row">
          <h3 className="card-title">{title}</h3>
          <span className="rating">
            <span className="star">★</span>
            {num(props.rating, 0).toFixed(2)}
          </span>
        </div>
        <p className="card-location">{str(props.location)}</p>
        <p className="card-price">
          <strong>${num(props.price)}</strong> <span className="muted">night</span>
        </p>
      </div>
    </article>
  );
}

function StatGrid(props: Record<string, unknown>): ReactNode {
  const stats = records(props.stats);
  if (stats.length === 0) {
    return null;
  }
  return (
    <div className="statgrid">
      {stats.map((s) => (
        <div className="stat" key={str(s.label)}>
          <span className="stat-value">{str(s.value, String(s.value ?? ''))}</span>
          <span className="stat-label">{str(s.label)}</span>
        </div>
      ))}
    </div>
  );
}

function PriceBreakdown(props: Record<string, unknown>): ReactNode {
  const nightly = num(props.nightly);
  const nightsN = num(props.nights, 1);
  const cleaning = num(props.cleaning);
  const total = num(props.total, nightly * nightsN + cleaning);
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
}

function Heading(props: Record<string, unknown>): ReactNode {
  return <h2 className="heading">{str(props.text)}</h2>;
}

function Text(props: Record<string, unknown>): ReactNode {
  return <p className="text">{str(props.value)}</p>;
}

function Stack(props: Record<string, unknown>): ReactNode {
  return <div className="stack">{nodes(props.children)}</div>;
}

function Button(props: Record<string, unknown>): ReactNode {
  const onPress = fn(props.onPress);
  return (
    <button type="button" className="button" onClick={onPress}>
      {str(props.label, 'Continue')}
    </button>
  );
}

//#endregion

//#region Registry (prop order MUST match the server library declaration order)

export const REGISTRY: Record<string, ComponentSpec> = {
  Page: {
    props: [
      'title',
      'subtitle',
      'children',
    ],
    render: (p) => Page(p),
  },
  SearchBar: {
    props: [
      'location',
      'guests',
    ],
    render: (p, ctx) => SearchBar(p, ctx),
  },
  SortBar: {
    props: [
      'children',
    ],
    render: (p) => SortBar(p),
  },
  SortChip: {
    props: [
      'label',
      'active',
      'onPress',
    ],
    render: (p) => SortChip(p),
  },
  ListingGrid: {
    props: [
      'children',
    ],
    render: (p) => ListingGrid(p),
  },
  ListingCard: {
    props: [
      'title',
      'location',
      'price',
      'rating',
      'image',
      'superhost',
      'highlight',
      'onSelect',
    ],
    render: (p) => ListingCard(p),
  },
  StatGrid: {
    props: [
      'stats',
    ],
    render: (p) => StatGrid(p),
  },
  PriceBreakdown: {
    props: [
      'nightly',
      'nights',
      'cleaning',
      'total',
    ],
    render: (p) => PriceBreakdown(p),
  },
  Heading: {
    props: [
      'text',
    ],
    render: (p) => Heading(p),
  },
  Text: {
    props: [
      'value',
    ],
    render: (p) => Text(p),
  },
  Stack: {
    props: [
      'children',
    ],
    render: (p) => Stack(p),
  },
  Button: {
    props: [
      'label',
      'onPress',
    ],
    render: (p) => Button(p),
  },
};

//#endregion
