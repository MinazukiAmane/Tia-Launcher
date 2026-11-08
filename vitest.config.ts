import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    exclude: ['**/node_modules/**', '**/.worktrees/**', '**/worktrees/**']
  }
})
