import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/conformance/index.ts'],
  dts: true,
})
