/** @type {import('next').NextConfig} */
const nextConfig = {
  // Use Next.js dev server for proper dynamic routing
  // This enables proper useParams() for /{agentSlug}/{runId} routes
  distDir: 'dist',
  // Skip type checking during build — run separately via `bun run typecheck`
  // Needed because workspace dep @noetic/core uses bun-types not available in Next.js build worker
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Proxy API requests to the UI service
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3334/api/:path*',
      },
      {
        source: '/health',
        destination: 'http://localhost:3334/health',
      },
    ];
  },
};

export default nextConfig;
