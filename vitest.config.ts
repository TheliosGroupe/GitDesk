import { defineConfig } from 'vitest/config'

// Unit tests for the pure libraries (no Electron, no DOM). The end-to-end
// tests in tests/*.mjs drive the built app and run with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Many tests drive real git processes: slow CI runners (Windows, macOS) need headroom.
    testTimeout: 20000,
    hookTimeout: 20000
  }
})
