# Single entry point for project commands (see AGENTS.md › Makefile).
# Targets are thin wrappers over pnpm; Node >= 22.18 runs the TypeScript sources directly.

.DEFAULT_GOAL := help
.PHONY: help install typecheck test verify audit secrets lint-workflows ci daemon cli doctor clean

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "} {printf "  make %-10s %s\n", $$1, $$2}'

install: ## Install dependencies (pnpm workspaces)
	pnpm install --frozen-lockfile

typecheck: ## Type-check every package (tsc, no emit)
	pnpm typecheck

test: ## Run the test suite (Vitest)
	pnpm test

verify: typecheck test ## Typecheck + tests, the check before committing

audit: ## Fail on known high or critical vulnerabilities in dependencies
	pnpm audit --audit-level high

secrets: ## Scan the git history for committed secrets (needs gitleaks)
	gitleaks git --redact --no-banner .

lint-workflows: ## Lint the GitHub Actions workflows (needs actionlint)
	actionlint

ci: verify audit secrets lint-workflows ## Every quality gate the CI pipelines run

daemon: ## Run navarchd in the foreground (NAVARCH_HOME defaults to ~/.navarch)
	node apps/daemon/src/main.ts

cli: ## Run the CLI: make cli ARGS="run list"
	node apps/cli/src/main.ts $(ARGS)

doctor: ## Check the toolchain Navarch needs
	@node --version
	@pnpm --version
	@git --version
	@claude --version || echo "claude CLI not found: the claude-code adapter will not work"
	@gemini --version || echo "gemini CLI not found: the gemini-cli adapter will not work"
	@agy --version || echo "agy CLI not found: the antigravity adapter will not work"
	@codex --version || echo "codex CLI not found: the codex adapter will not work"
	@copilot --version || echo "copilot CLI not found: the copilot adapter will not work"
	@ollama --version || echo "ollama not found: native runs need another provider"

clean: ## Remove installed dependencies and caches
	rm -rf node_modules apps/*/node_modules packages/*/node_modules packages/adapters/*/node_modules
