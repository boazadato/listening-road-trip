// Stub — replaced in Task 6. Required now so index.ts builds.
import type { Env } from './types'

export class TripRoom {
  constructor(_state: DurableObjectState, _env: Env) {}
  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  }
}
