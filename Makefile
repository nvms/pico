dev: build ## Build and run pico
	@node dist/pico.js

build: ## Bundle src into dist/pico.js
	@node esbuild.config.js

test: ## Run the core test suite
	@node --test 'test/**/*.test.js'

link: build ## npm link the pico bin globally
	@npm link

.PHONY: help dev build test link
help: ## Show help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[32m%-20s\033[0m %s\n", $$1, $$2}'
