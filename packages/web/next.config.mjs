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
    ];
  },
};

export default withMDX(config);
