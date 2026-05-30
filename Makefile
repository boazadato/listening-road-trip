.PHONY: setup dev build test test-fast deploy

# First-time setup: install git hooks
setup:
	cp scripts/pre-commit .git/hooks/pre-commit
	chmod +x .git/hooks/pre-commit
	@echo "✅ Pre-commit hook installed"

# Build frontend static assets (Worker serves them)
build:
	cd frontend && pnpm build

# Local dev: build frontend then start Worker with Miniflare (DOs + D1 emulated)
dev: build
	cd worker && npx wrangler dev --local

# Full test suite: unit tests + API integration tests + type-check
test:
	cd worker && pnpm test
	cd frontend && pnpm test
	cd worker && npx tsc --noEmit
	cd frontend && npx tsc --noEmit

# Fast tests only: pure unit tests + type-check (used by pre-commit hook)
test-fast:
	cd worker && npx vitest run --reporter=verbose --passWithNoTests test/utils.test.ts test/spotify.test.ts
	cd worker && npx tsc --noEmit
	cd frontend && npx tsc --noEmit

# Deploy to Cloudflare (build first, apply schema, then deploy Worker)
deploy: build
	cd worker && npx wrangler d1 execute listening-road-trip --file=schema.sql
	cd worker && npx wrangler deploy
