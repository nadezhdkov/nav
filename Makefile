# Single entry point for project commands (see AGENTS.md › Makefile).
# Targets are thin wrappers over pnpm; Node >= 22.18 runs the TypeScript sources directly.

.DEFAULT_GOAL := help
.PHONY: help install typecheck test verify web-build web-dev web site-build site-dev audit secrets lint-workflows ci daemon relay cli chat doctor clean

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "} {printf "  make %-10s %s\n", $$1, $$2}'

install: ## Install dependencies (pnpm workspaces)
	pnpm install --frozen-lockfile

typecheck: ## Type-check every package (tsc; vue-tsc for apps/web and site)
	pnpm typecheck

test: ## Run the test suite (Vitest)
	pnpm test

verify: typecheck test ## Typecheck + tests, the check before committing

web-build: ## Build the Web UI into apps/web/dist (navarchd serves it at /)
	pnpm build:web

web-dev: ## Vite dev server for the Web UI, proxying /api to a running navarchd
	pnpm dev:web

web: ## Open the Web UI in the browser (needs a running daemon and make web-build)
	node apps/cli/src/main.ts web

site-build: ## Build the public site into site/dist (SITE_BASE=/nav/ for GitHub Pages)
	pnpm build:site

site-dev: ## Vite dev server for the public site
	pnpm dev:site

audit: ## Fail on known high or critical vulnerabilities in dependencies
	pnpm audit --audit-level high

secrets: ## Scan the git history for committed secrets (needs gitleaks)
	gitleaks git --redact --no-banner .

lint-workflows: ## Lint the GitHub Actions workflows (needs actionlint)
	actionlint

ci: verify web-build site-build audit secrets lint-workflows ## Every quality gate the CI pipelines run

daemon: ## Run navarchd in the foreground (NAVARCH_HOME defaults to ~/.navarch); warns when dependencies are stale
	@node apps/cli/src/check-deps.ts
	node apps/daemon/src/main.ts

relay: ## Run the relay (navarch-relay) in the foreground; put a TLS proxy in front (PORT, HOST, RELAY_STATE)
	node apps/relay/src/main.ts

cli: ## Run the CLI: make cli ARGS="run list"
	node apps/cli/src/main.ts $(ARGS)

chat: ## Talk to the concierge (needs a running daemon and concierge.model)
	node apps/cli/src/main.ts chat

doctor: ## Check the toolchain Navarch needs
	@node --version
	@pnpm --version
	@git --version
	@claude --version || echo "claude CLI not found: the claude-code adapter will not work"
	@gemini --version || echo "gemini CLI not found: the gemini-cli adapter will not work"
	@agy --version || echo "agy CLI not found: the antigravity adapter will not work"
	@codex --version || echo "codex CLI not found: the codex adapter will not work"
	@copilot --version || echo "copilot CLI not found: the copilot adapter will not work"
	@opencode --version || echo "opencode CLI not found on PATH: set adapters.opencode.command or the opencode adapter will not work"
	@kilo --version 2>/dev/null || ~/.kilo/bin/kilo --version 2>/dev/null || echo "kilo CLI not found: the kilo adapter will not work"
	@grok --version || echo "grok CLI not found: the grok adapter will not work"
	@ollama --version || echo "ollama not found: native runs need another provider"

clean: ## Remove installed dependencies and caches
	rm -rf node_modules apps/*/node_modules packages/*/node_modules packages/adapters/*/node_modules site/node_modules apps/web/dist site/dist
