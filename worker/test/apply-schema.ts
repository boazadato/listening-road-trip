// Runs once per test file (vitest setupFile) — recreates the schema in the isolated test D1.
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test'
import { beforeAll } from 'vitest'
import type { Env } from '../src/types'

interface TestEnv extends Env {
  TEST_SCHEMA_STATEMENTS: string[]
}

beforeAll(async () => {
  const testEnv = env as unknown as TestEnv
  for (const stmt of testEnv.TEST_SCHEMA_STATEMENTS) {
    await testEnv.DB.prepare(stmt).run()
  }
})
