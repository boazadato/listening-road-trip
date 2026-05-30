// Types the `env` from 'cloudflare:test' (declared as `Cloudflare.Env`) with our Worker
// bindings (DB, TRIP_ROOM, …) plus the test-only schema statements injected by
// vitest.config.ts. Without this, `Cloudflare.Env` is an empty interface and
// `env.DB`/`env.TRIP_ROOM` don't type-check.
import type { Env as WorkerEnv } from '../src/types'

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_SCHEMA_STATEMENTS: string[]
    }
  }
}
