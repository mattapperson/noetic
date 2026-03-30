/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: 'dist',
  images: {
    unoptimized: true,
  },
  // Rewrites are not supported in static export, so we'll use API routes or proxy instead
  // For development, the WebSocket server runs on a separate port
};

module.exports = nextConfig;
