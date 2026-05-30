// Stub — replaced in Task 7. Required now so the vitest-pool-workers build resolves.
import type { Env } from './types'

export { TripRoom } from './TripRoom'

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  },
}
