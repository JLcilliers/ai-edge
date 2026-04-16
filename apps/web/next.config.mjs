/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  transpilePackages: ['@ai-edge/shared', '@ai-edge/db'],
};
