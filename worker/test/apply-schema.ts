// Runs once per test file (vitest setupFile) — recreates the schema in the isolated test D1.
import { env } from 'cloudflare:test'
import { beforeAll } from 'vitest'
import type { Env } from '../src/types'

declare module 'cloudflare:test' {
  // Extends the worker Env so env.DB (and friends) are typed, plus our test-only binding.
  interface ProvidedEnv extends Env {
    TEST_SCHEMA_STATEMENTS: string[]
  }
}

beforeAll(async () => {
  for (const stmt of env.TEST_SCHEMA_STATEMENTS) {
    await env.DB.prepare(stmt).run()
  }
})
