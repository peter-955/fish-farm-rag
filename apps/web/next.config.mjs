import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Lets any *.module.scss do `@use 'tokens' as t;` regardless of its depth.
  sassOptions: {
    loadPaths: [path.join(dirname, 'src/styles')],
    includePaths: [path.join(dirname, 'src/styles')],
  },
};

export default nextConfig;
