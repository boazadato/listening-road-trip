> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 1: Project Scaffold

**Prerequisites:** None — this is the first task. The repo root contains only `CLAUDE.md`, `Makefile`, `scripts/`, and `docs/`.

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `wrangler.toml`
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/vitest.config.ts`
- Create: `worker/test/apply-schema.ts`
- Create: `worker/.dev.vars`
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/test-setup.ts`
- Create: `frontend/index.html`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# .gitignore
node_modules/
frontend-dist/
.wrangler/
dist/
.dev.vars
*.log
.DS_Store
```

- [ ] **Step 2: Create pnpm workspace root**

> pnpm reads workspace members from `pnpm-workspace.yaml`, **not** the `workspaces` field in `package.json` (that field is npm/yarn-only and pnpm ignores it). Without the YAML file, `pnpm install` won't link `worker/` and `frontend/` and `make dev`/`make test` fail at step one. Create both files.

```json
// package.json
{
  "name": "listening-road-trip",
  "private": true,
  "packageManager": "pnpm@9.0.0"
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - worker
  - frontend
```

- [ ] **Step 3: Create worker package**

We use the Claude and Spotify APIs via raw `fetch` — no SDK dependency.

```json
// worker/package.json
{
  "name": "listening-road-trip-worker",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.16.3",
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.6.0",
    "vitest": "^4.1.0",
    "wrangler": "^4.95.0"
  }
}
```

```json
// worker/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

The test D1 starts empty — nothing creates the tables — so without this the `SELF` integration tests fail with `no such table: trips`. We read `schema.sql` at config time (Node context, where `fs` is available), split it into statements, and pass them as a test-only binding that a setup file applies before each test file. This keeps `schema.sql` the single source of truth (no separate migrations dir).

```typescript
// worker/vitest.config.ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8')
// Split into individual statements (statements end with ';'; no ';' appears inside our schema).
// Strip `--` comment lines *within* each chunk first — a leading comment must not cause the
// statement after it to be dropped (e.g. the comment above `analysis_cache`).
const schemaStatements = schema
  .split(';')
  .map(chunk =>
    chunk
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
      .trim()
  )
  .filter(s => s.length > 0)

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/apply-schema.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: '../wrangler.toml' },
        miniflare: {
          bindings: { TEST_SCHEMA_STATEMENTS: schemaStatements },
        },
      },
    },
  },
})
```

```typescript
// worker/test/apply-schema.ts
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
```

> `schema.sql` uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so re-applying per test file is idempotent. This file is referenced by `vitest.config.ts` above, so it must exist from Task 1 onward — otherwise the Task 3/4 unit tests fail to load the setup file.

```
# worker/.dev.vars  (gitignored — local secrets for `wrangler dev`)
SPOTIFY_CLIENT_ID=your_local_client_id
SPOTIFY_CLIENT_SECRET=your_local_client_secret
CLAUDE_API_KEY=your_local_claude_key
```

> For pure local UI work you can leave these as placeholders — Spotify polling just no-ops until a real token exists. Real values are only needed to test the live OAuth + polling path.

- [ ] **Step 4: Create frontend package**

```json
// frontend/package.json
{
  "name": "listening-road-trip-frontend",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0",
    "zustand": "^4.5.5",
    "qrcode.react": "^4.1.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^4.1.0"
  }
}
```

```json
// frontend/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

```typescript
// frontend/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: { outDir: '../frontend-dist', emptyOutDir: true },
})
```

```typescript
// frontend/vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
```

```typescript
// frontend/src/test-setup.ts
import '@testing-library/jest-dom/vitest'
```

```html
<!-- frontend/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Listening Road Trip 🚗</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create wrangler.toml**

The `database_id` is a placeholder for local dev (Miniflare ignores it). The real id is created and filled in at deploy (Task 17). The Spotify redirect URI is derived from the request origin at runtime — no config needed here.

Three settings here are load-bearing and were wrong/missing in the prior draft (verified against current Cloudflare docs):
- **`not_found_handling = "single-page-application"`** — without it, deep links like `/trip/:code` and the **Spotify OAuth redirect landing** (`spotifyCallback` redirects to `/trip/<code>`) return a 404 in production. This breaks the core creator flow.
- **`run_worker_first`** — routes `/api/*` and `/ws` to the Worker (not static assets), while everything else falls through to the SPA. (Asset files like `/assets/*` are still served directly.)
- **`new_sqlite_classes`** (not `new_classes`) — Cloudflare recommends the SQLite storage backend for all new Durable Object classes, and **the choice is irreversible** ("you cannot enable a SQLite storage backend on an existing, deployed Durable Object class"). KV-backed `new_classes` would lock us into the legacy backend permanently. The DO uses the KV-style `ctx.storage.get/put` API, which works on the SQLite backend too — no code change needed.

```toml
# wrangler.toml
name = "listening-road-trip"
main = "worker/src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./frontend-dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/ws"]

[[durable_objects.bindings]]
name = "TRIP_ROOM"
class_name = "TripRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TripRoom"]

[[d1_databases]]
binding = "DB"
database_name = "listening-road-trip"
database_id = "placeholder-local-dev"   # replace with real id at deploy (Task 17)

[vars]
ENVIRONMENT = "development"

# Secrets (set via `wrangler secret put` at deploy — Task 17):
# SPOTIFY_CLIENT_ID
# SPOTIFY_CLIENT_SECRET
# CLAUDE_API_KEY
```

- [ ] **Step 6: Install dependencies**

```bash
pnpm install
```

Expected: packages installed in `worker/node_modules` and `frontend/node_modules`.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json pnpm-workspace.yaml wrangler.toml worker/ frontend/
git commit -m "feat: scaffold project — pnpm workspaces, Worker, React/Vite, wrangler config" && git push
```

