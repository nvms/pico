PICO := packages/pico

dev: build ## Build and run pico
	@node $(PICO)/dist/pico.js

build: ## Bundle pico into packages/pico/dist/pico.js
	@npm run build -w picocode

test: ## Run every workspace test suite
	@npm test --workspaces

link: build ## Symlink the pico bin into /opt/homebrew/bin
	@ln -sf $(CURDIR)/$(PICO)/bin/pico /opt/homebrew/bin/pico

release: ## Bump both packages to v=x.y.z, commit, and tag
	@test -n "$(v)" || (echo "usage: make release v=x.y.z" && exit 1)
	@npm version $(v) --workspaces --no-git-tag-version >/dev/null
	@npm pkg set dependencies.picocode-core=$(v) -w picocode
	@npm install --package-lock-only >/dev/null
	@git add package-lock.json packages/*/package.json
	@git commit -qm "release $(v)"
	@git tag v$(v)
	@echo "released $(v); push with: git push && git push --tags"

deps-local: ## Point @trendr/core and @prsm/ai at local working trees
	@rm -rf node_modules/@trendr/core node_modules/@prsm/ai
	@ln -s $(abspath ../trend) node_modules/@trendr/core
	@ln -s $(abspath ../vigil/tend/prsmjs/ai) node_modules/@prsm/ai
	@echo "linked local trend and prsm/ai (make deps-npm to restore)"

deps-npm: ## Restore published deps from npm
	@npm install

.PHONY: help dev build test link release deps-local deps-npm
help: ## Show help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[32m%-20s\033[0m %s\n", $$1, $$2}'
