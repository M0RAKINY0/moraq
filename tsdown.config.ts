import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/redis.ts'],
  format: ['esm'],
  dts: true,
  platform: 'node',
  target: 'node22',
})
