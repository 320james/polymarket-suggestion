/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Single-user app: no need to cache pages.
  experimental: {
    staleTimes: { dynamic: 0, static: 0 },
    // Treat @prisma/client as a server-side native dep so Next doesn't try to bundle it.
    serverComponentsExternalPackages: ["@prisma/client", "prisma"],
  },
};

export default nextConfig;
