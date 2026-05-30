import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const schema = readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf-8')
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

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: '../wrangler.toml' },
    miniflare: {
      bindings: { TEST_SCHEMA_STATEMENTS: schemaStatements },
    },
  })],
  test: {
    setupFiles: ['./test/apply-schema.ts'],
  },
})
