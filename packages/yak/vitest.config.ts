import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: ['**/node_modules/**', 'fixtures/**', '.yak/**', '.runs/**'],
    // Host git config must not leak into temp repos. `commit.gpgsign`
    // makes `git commit` wait on a signing helper, and `core.fsmonitor`
    // makes status/commit wait on a daemon — both hang the suite when
    // many repos run git at once. `-c` flags on a single command still win.
    env: {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
    },
  },
})
