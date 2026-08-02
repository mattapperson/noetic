import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  async redirects() {
    return [
      {
        source: '/docs/getting-started',
        destination: '/docs/framework',
        permanent: false,
      },
      {
        source: '/docs/quickstart',
        destination: '/docs/framework',
        permanent: false,
      },
      {
        source: '/docs/framework/getting-started',
        destination: '/docs/framework',
        permanent: false,
      },
      {
        source: '/docs/framework/get-started',
        destination: '/docs/framework',
        permanent: false,
      },
      {
        source: '/docs/framework/quickstart',
        destination: '/docs/framework',
        permanent: false,
      },
      // Memory layers were renamed to context layers. These pages moved as a
      // set; the four layers whose own names changed get explicit entries
      // because the wildcard below cannot rewrite the slug.
      {
        source: '/docs/framework/memory/working-memory',
        destination: '/docs/framework/context-layers/working-memory-context',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/observational-memory',
        destination: '/docs/framework/context-layers/observational-context',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/temporal-memory',
        destination: '/docs/framework/context-layers/temporal-context',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/plan-memory',
        destination: '/docs/framework/context-layers/plan-context',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/tool-memory',
        destination: '/docs/framework/context-layers/tool-context',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/episodic-memory',
        destination: '/docs/framework/context-layers/episodic-context',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/:slug*',
        destination: '/docs/framework/context-layers/:slug*',
        permanent: true,
      },
      {
        source: '/docs/framework/api/memory-types',
        destination: '/docs/framework/api/context-layer-types',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
