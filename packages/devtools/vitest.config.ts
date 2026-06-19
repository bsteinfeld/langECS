import { defineConfig } from 'vitest/config';

// vite.config.ts sets `root: 'ui'` for the UI build; without this file vitest
// would inherit that root and look for tests in ui/. This config takes
// precedence and points test discovery at the server's test/ directory.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'ui/**/*.test.ts'],
  },
});
