// Bundles the compiled app and every dependency into one ESM file. Vercel's Node runtime cannot require() the
// ESM-only @nestjs/* packages from CommonJS dependencies (e.g. @nestjs/throttler); bundling removes that require().
import { build } from 'esbuild';

await build({
  entryPoints: ['scripts/vercel-entry.mjs'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  // Optional Nest peer dependencies that are loaded lazily and not installed here.
  external: [
    '@nestjs/microservices',
    '@nestjs/websockets',
    '@nestjs/platform-socket.io',
    '@nestjs/platform-fastify',
    'class-transformer/storage',
    '@fastify/static',
    '@fastify/view',
    'cache-manager',
    'ioredis',
    'kafkajs',
    'mqtt',
    'nats',
    'amqplib',
    'amqp-connection-manager',
    '@grpc/grpc-js',
    '@grpc/proto-loader',
  ],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
