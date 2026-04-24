/** @type {import('next').NextConfig} */
const nextConfig = {
  // Use Next.js dev server for proper dynamic routing
  // This enables proper useParams() for /{agentSlug}/{runId} routes
  distDir: 'dist',
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
