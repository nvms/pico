dev: build ## Build and run pico
	@node dist/pico.js

build: ## Bundle src into dist/pico.js
	@node esbuild.config.js

test: ## Run the core test suite
	@node --test 'test/**/*.test.js'

link: build ## Symlink the pico bin into /opt/homebrew/bin
	@ln -sf $(CURDIR)/bin/pico /opt/homebrew/bin/pico

deps-local: ## Point @trendr/core and @prsm/ai at local working trees
	@rm -rf node_modules/@trendr/core node_modules/@prsm/ai
	@ln -s $(abspath ../trend) node_modules/@trendr/core
	@ln -s $(abspath ../vigil/tend/prsmjs/ai) node_modules/@prsm/ai
	@echo "linked local trend and prsm/ai (make deps-npm to restore)"

deps-npm: ## Restore published deps from npm
	@npm install

.PHONY: help dev build test link
help: ## Show help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[32m%-20s\033[0m %s\n", $$1, $$2}'
