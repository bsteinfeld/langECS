import { defineConfig } from 'vitest/config';

// vite.config.ts sets `root: 'ui'` for the UI build; without this file vitest
// would inherit that root and look for tests in ui/. This config takes
// precedence and points test discovery at two locations: server tests in
// test/ and UI-logic tests in ui/ (typechecked by the DOM-aware ui tsconfig).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'ui/**/*.test.ts'],
  },
});
