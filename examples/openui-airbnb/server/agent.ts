/**
 * The Annapolis-stays generative-UI agent.
 *
 * The point of this demo is *intent-adaptive* UI: the model reads what the guest
 * asked for and decides what to feature. "Homes with the most bedrooms" makes
 * every card lead with its bedroom count and sorts by it; "near City Dock" makes
 * cards lead with walking distance and offers a sort-by-distance control. The
 * server just gives the model rich data (`search_listings` with `near`/`sort`)
 * and an expressive component vocabulary; the model composes the screen.
 */

import type { ContextMemory } from '@noetic-tools/core';
import { AgentHarness, step, tool } from '@noetic-tools/core';
import { createLibrary, defineComponent, openUi, openUiSurface } from '@noetic-tools/openui';
import { z } from 'zod';

//#region Component library — the vocabulary the model renders

/**
 * Prop *order* matters — OpenUI Lang passes positional args mapped to these keys
 * in declaration order. The client (../client/components.tsx) maps each name to a
 * styled React component with the SAME prop order.
 */
export const library = createLibrary([
  defineComponent({
    name: 'Page',
    description:
      'Page shell. `subtitle` frames the results, e.g. "8 stays · sorted by distance to City Dock".',
    props: z.object({
      title: z.string(),
      subtitle: z.string(),
      children: z.array(z.unknown()),
    }),
  }),
  defineComponent({
    name: 'SearchBar',
    description: 'Search header. Bind $location and $guests so edits re-drive search_listings.',
    props: z.object({
      location: z.string(),
      guests: z.number(),
    }),
  }),
  defineComponent({
    name: 'SortBar',
    description:
      'A row of SortChip children letting the guest re-sort. Show only sorts relevant to their intent.',
    props: z.object({
      children: z.array(z.unknown()),
    }),
  }),
  defineComponent({
    name: 'SortChip',
    description:
      'One sort option. Mark the active one with active=true. Pass an Action to onPress, e.g. Action([@ToAssistant("Sort these by distance to City Dock")]).',
    props: z.object({
      label: z.string(),
      active: z.boolean(),
      onPress: z.unknown(),
    }),
  }),
  defineComponent({
    name: 'ListingGrid',
    description: 'Responsive grid of ListingCard children.',
    props: z.object({
      children: z.array(z.unknown()),
    }),
  }),
  defineComponent({
    name: 'ListingCard',
    description:
      'A stay. `highlight` is the ONE fact the guest cares about most, featured prominently — set it to the bedroom count when they want bedrooms, or the walking distance when they search near a place (e.g. "5 bedrooms · sleeps 10" or "0.3 mi to City Dock"). Pass an Action to onSelect to open the detail.',
    props: z.object({
      title: z.string(),
      location: z.string(),
      price: z.number(),
      rating: z.number(),
      image: z.string(),
      superhost: z.boolean(),
      highlight: z.string(),
      onSelect: z.unknown().optional(),
    }),
  }),
  defineComponent({
    name: 'StatGrid',
    description:
      'A grid of stat tiles for the detail screen. `stats` is an array of { label, value } objects; lead with the stats the guest cares about (bedrooms, or distance).',
    props: z.object({
      stats: z.array(z.unknown()),
    }),
  }),
  defineComponent({
    name: 'PriceBreakdown',
    description: 'Booking price summary from a quote_price result.',
    props: z.object({
      nightly: z.number(),
      nights: z.number(),
      cleaning: z.number(),
      total: z.number(),
    }),
  }),
  defineComponent({
    name: 'Heading',
    props: z.object({
      text: z.string(),
    }),
  }),
  defineComponent({
    name: 'Text',
    props: z.object({
      value: z.string(),
    }),
  }),
  defineComponent({
    name: 'Stack',
    description: 'Vertical stack of children.',
    props: z.object({
      children: z.array(z.unknown()),
    }),
  }),
  defineComponent({
    name: 'Button',
    description: 'A primary button. Pass an Action to onPress.',
    props: z.object({
      label: z.string(),
      onPress: z.unknown().optional(),
    }),
  }),
]);

//#endregion

//#region Data — Annapolis stays

interface Listing {
  id: string;
  title: string;
  neighborhood: string;
  price: number;
  rating: number;
  bedrooms: number;
  beds: number;
  baths: number;
  sleeps: number;
  lat: number;
  lng: number;
  superhost: boolean;
  image: string;
}

const LISTINGS: readonly Listing[] = [
  {
    id: 'a1',
    title: "Sailor's studio steps from the harbor",
    neighborhood: 'Historic Downtown',
    price: 162,
    rating: 4.92,
    bedrooms: 1,
    beds: 1,
    baths: 1,
    sleeps: 2,
    lat: 38.9779,
    lng: -76.4831,
    superhost: true,
    image: 'harbor-studio',
  },
  {
    id: 'a2',
    title: 'Sunny loft above Main Street',
    neighborhood: 'Historic Downtown',
    price: 188,
    rating: 4.9,
    bedrooms: 1,
    beds: 2,
    baths: 1,
    sleeps: 3,
    lat: 38.9785,
    lng: -76.4855,
    superhost: false,
    image: 'main-street-loft',
  },
  {
    id: 'a3',
    title: 'Historic Georgian on Prince George St',
    neighborhood: 'Historic Downtown',
    price: 274,
    rating: 4.96,
    bedrooms: 3,
    beds: 4,
    baths: 2,
    sleeps: 6,
    lat: 38.9808,
    lng: -76.4845,
    superhost: true,
    image: 'georgian-brick',
  },
  {
    id: 'a4',
    title: 'Waterfront cottage on Spa Creek',
    neighborhood: 'Eastport',
    price: 245,
    rating: 4.94,
    bedrooms: 2,
    beds: 3,
    baths: 2,
    sleeps: 5,
    lat: 38.973,
    lng: -76.482,
    superhost: true,
    image: 'spa-creek-cottage',
  },
  {
    id: 'a5',
    title: 'Eastport bungalow with private dock',
    neighborhood: 'Eastport',
    price: 312,
    rating: 4.89,
    bedrooms: 4,
    beds: 5,
    baths: 3,
    sleeps: 9,
    lat: 38.9705,
    lng: -76.479,
    superhost: true,
    image: 'eastport-dock',
  },
  {
    id: 'a6',
    title: 'Grand colonial near the Naval Academy',
    neighborhood: 'West Annapolis',
    price: 355,
    rating: 4.97,
    bedrooms: 5,
    beds: 7,
    baths: 4,
    sleeps: 11,
    lat: 38.985,
    lng: -76.485,
    superhost: true,
    image: 'naval-colonial',
  },
  {
    id: 'a7',
    title: 'Murray Hill Victorian for the whole crew',
    neighborhood: 'Murray Hill',
    price: 398,
    rating: 4.95,
    bedrooms: 6,
    beds: 8,
    baths: 4,
    sleeps: 13,
    lat: 38.982,
    lng: -76.492,
    superhost: true,
    image: 'murray-hill-victorian',
  },
  {
    id: 'a8',
    title: 'Modern townhome near Town Center',
    neighborhood: 'Parole',
    price: 176,
    rating: 4.85,
    bedrooms: 3,
    beds: 3,
    baths: 3,
    sleeps: 6,
    lat: 38.976,
    lng: -76.545,
    superhost: false,
    image: 'parole-townhome',
  },
];

/** Landmarks a guest might search "near". */
const LANDMARKS: Record<
  string,
  {
    name: string;
    lat: number;
    lng: number;
  }
> = {
  'city dock': {
    name: 'City Dock',
    lat: 38.9784,
    lng: -76.4839,
  },
  'naval academy': {
    name: 'the Naval Academy',
    lat: 38.9847,
    lng: -76.482,
  },
  'town center': {
    name: 'Annapolis Town Center',
    lat: 38.9686,
    lng: -76.549,
  },
};

interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in miles between two points. */
function haversineMi(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function resolveLandmark(near: string | undefined):
  | {
      name: string;
      lat: number;
      lng: number;
    }
  | undefined {
  if (!near) {
    return undefined;
  }
  const needle = near.trim().toLowerCase();
  for (const [key, landmark] of Object.entries(LANDMARKS)) {
    if (needle.includes(key)) {
      return landmark;
    }
  }
  return undefined;
}

//#endregion

//#region Tools

const SortKey = {
  Distance: 'distance',
  Bedrooms: 'bedrooms',
  Price: 'price',
  Rating: 'rating',
} as const;
type SortKey = (typeof SortKey)[keyof typeof SortKey];

const searchListings = tool({
  name: 'search_listings',
  description:
    'Search Annapolis stays. Infer `near` and `sort` from the guest\'s intent: "most bedrooms" → sort:"bedrooms"; "near City Dock" → near:"city dock", sort:"distance". Returns rows (with distanceMi when `near` is set), already sorted.',
  input: z.object({
    query: z.string().describe('The raw guest search text.'),
    guests: z.number().int().positive().default(2),
    near: z
      .string()
      .optional()
      .describe('A landmark to measure from: "city dock", "naval academy", or "town center".'),
    sort: z
      .enum([
        SortKey.Distance,
        SortKey.Bedrooms,
        SortKey.Price,
        SortKey.Rating,
      ])
      .optional(),
  }),
  output: z.object({
    landmark: z.string().optional(),
    activeSort: z.string(),
    rows: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        neighborhood: z.string(),
        price: z.number(),
        rating: z.number(),
        bedrooms: z.number(),
        beds: z.number(),
        baths: z.number(),
        sleeps: z.number(),
        superhost: z.boolean(),
        image: z.string(),
        distanceMi: z.number().optional(),
      }),
    ),
  }),
  async execute({ near, sort }) {
    const landmark = resolveLandmark(near);
    const withDistance = LISTINGS.map((l) => ({
      id: l.id,
      title: l.title,
      neighborhood: l.neighborhood,
      price: l.price,
      rating: l.rating,
      bedrooms: l.bedrooms,
      beds: l.beds,
      baths: l.baths,
      sleeps: l.sleeps,
      superhost: l.superhost,
      image: l.image,
      distanceMi: landmark ? Math.round(haversineMi(landmark, l) * 10) / 10 : undefined,
    }));
    const activeSort: SortKey = sort ?? (landmark ? SortKey.Distance : SortKey.Rating);
    const sorters: Record<
      SortKey,
      (a: (typeof withDistance)[number], b: (typeof withDistance)[number]) => number
    > = {
      distance: (a, b) => (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9),
      bedrooms: (a, b) => b.bedrooms - a.bedrooms,
      price: (a, b) => a.price - b.price,
      rating: (a, b) => b.rating - a.rating,
    };
    const rows = [
      ...withDistance,
    ].sort(sorters[activeSort]);
    return {
      landmark: landmark?.name,
      activeSort,
      rows,
    };
  },
});

const quotePrice = tool({
  name: 'quote_price',
  description: 'Quote the total booking price for a listing and a number of nights.',
  input: z.object({
    listingId: z.string(),
    nights: z.number().int().positive().default(4),
  }),
  output: z.object({
    nightly: z.number(),
    nights: z.number(),
    cleaning: z.number(),
    total: z.number(),
  }),
  async execute({ listingId, nights }) {
    const listing = LISTINGS.find((l) => l.id === listingId) ?? LISTINGS[0];
    const nightly = listing.price;
    const cleaning = 60;
    return {
      nightly,
      nights,
      cleaning,
      total: nightly * nights + cleaning,
    };
  },
});

//#endregion

//#region Step + harness

const INSTRUCTIONS = [
  'You are the UI for an Annapolis, Maryland stays app in the spirit of Airbnb.',
  'Answer every request by rendering a screen with the registered components — never plain prose.',
  '',
  'Adapt the UI to the intent. CALL search_listings, inferring `near` and `sort` from what the guest asked:',
  '- "most/more bedrooms", "big group", "sleeps N" → sort:"bedrooms".',
  '- "near/close to/walk to <place>" → near that landmark, sort:"distance".',
  '- otherwise sort by rating.',
  'Then feature the fact they care about: set each `ListingCard.highlight` to the bedroom line when they',
  'want bedrooms ("5 bedrooms · sleeps 11") or the walking distance when they searched near a place',
  '("0.3 mi to City Dock"). Render in the returned (already-sorted) order, set the Page `subtitle` to',
  'explain the framing, and show a `SortBar` with the 2–3 sorts relevant to their intent (active one marked;',
  'each SortChip onPress = Action([@ToAssistant("Sort these by …")])).',
  '',
  'Example — "homes with the most bedrooms":',
  '```',
  '$location = "Annapolis"',
  '$guests = 8',
  'bar = SearchBar($location, $guests)',
  's1 = SortChip("Most bedrooms", true, Action([@ToAssistant("Sort by bedrooms")]))',
  's2 = SortChip("Top rated", false, Action([@ToAssistant("Sort by rating")]))',
  'sorts = SortBar([s1, s2])',
  'c1 = ListingCard("Murray Hill Victorian for the whole crew", "Murray Hill", 398, 4.95, "murray-hill-victorian", true, "6 bedrooms · sleeps 13", Action([@ToAssistant("Show details for the Murray Hill Victorian")]))',
  'c2 = ListingCard("Grand colonial near the Naval Academy", "West Annapolis", 355, 4.97, "naval-colonial", true, "5 bedrooms · sleeps 11", Action([@ToAssistant("Show details for the Grand colonial")]))',
  'grid = ListingGrid([c1, c2])',
  'root = Page("Annapolis stays", "8 stays · sorted by bedrooms", [bar, sorts, grid])',
  '```',
  '',
  'Example — "places near City Dock":',
  '```',
  '$location = "Annapolis"',
  '$guests = 2',
  'bar = SearchBar($location, $guests)',
  's1 = SortChip("Closest", true, Action([@ToAssistant("Sort by distance to City Dock")]))',
  's2 = SortChip("Price", false, Action([@ToAssistant("Sort by price")]))',
  'sorts = SortBar([s1, s2])',
  'c1 = ListingCard("Sailor\'s studio steps from the harbor", "Historic Downtown", 162, 4.92, "harbor-studio", true, "0.1 mi to City Dock", Action([@ToAssistant("Show details for the Sailor\'s studio")]))',
  'grid = ListingGrid([c1])',
  'root = Page("Stays near City Dock", "Sorted by walking distance to City Dock", [bar, sorts, grid])',
  '```',
  '',
  'For a specific stay, call quote_price and render a detail `Stack`: a `Heading`, the `ListingCard`, a',
  '`StatGrid` whose `stats` lead with what the guest cared about (e.g. [{label:"Bedrooms",value:"6"},',
  '{label:"Sleeps",value:"13"},{label:"Baths",value:"4"},{label:"To City Dock",value:"0.6 mi"}]), a',
  '`PriceBreakdown`, and a `Button("Back to stays", Action([@ToAssistant("Show me Annapolis stays")]))`.',
].join('\n');

export const stays = step.llm<ContextMemory, string, unknown>({
  id: 'stays-ui',
  model: 'anthropic/claude-sonnet-4.5',
  instructions: INSTRUCTIONS,
  tools: [
    searchListings,
    quotePrice,
  ],
  output: openUi(library),
});

export function createStaysHarness(): {
  harness: AgentHarness;
  surface: ReturnType<typeof openUiSurface>;
} {
  const surface = openUiSurface({
    library,
  });
  const harness = new AgentHarness({
    name: 'stays',
    initialStep: stays,
    params: {},
    memory: [
      surface,
    ],
    llm: {
      provider: 'openrouter',
    },
  });
  return {
    harness,
    surface,
  };
}

//#endregion
