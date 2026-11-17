.DEFAULT_GOAL := build

BROWSER_DIST_SOURCE ?= $(HOME)/github/yukino-code/packages/yukino/src/remote/browser/dist
BROWSER_DIST_TARGET := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))internal/remote/browser/dist

.PHONY: sync-browser-dist
sync-browser-dist:
	@test -s "$(BROWSER_DIST_SOURCE)/index.html" || { echo "Browser build missing: $(BROWSER_DIST_SOURCE)/index.html" >&2; exit 1; }
	@set -e; \
		task_browser_stage="$$(mktemp -d)"; \
		trap 'rm -rf "$$task_browser_stage"' EXIT HUP INT TERM; \
		cp -R "$(BROWSER_DIST_SOURCE)/." "$$task_browser_stage/"; \
		rm -rf "$(BROWSER_DIST_TARGET)"; \
		mkdir -p "$(BROWSER_DIST_TARGET)"; \
		cp -R "$$task_browser_stage/." "$(BROWSER_DIST_TARGET)/"

GO ?= go
NODE ?= node
BUILD_DIR ?= dist
BUILD_FLAGS ?= -trimpath
LDFLAGS ?= -s -w
BUILD_CGO_ENABLED ?= 0
TEST_FLAGS ?=
BUILD_GOOS := $(shell $(GO) env GOOS)
BINARY_SUFFIX := $(if $(filter windows,$(BUILD_GOOS)),.exe,)
CROSS_TARGETS := win32-arm64 linux-arm64 darwin-arm64 win32-x64 linux-x64 darwin-x64

.PHONY: build cross-compile $(CROSS_TARGETS)
build:
	@mkdir -p "$(BUILD_DIR)"
	CGO_ENABLED=$(BUILD_CGO_ENABLED) $(GO) build $(BUILD_FLAGS) -ldflags "$(LDFLAGS)" -o "$(BUILD_DIR)/yukino$(BINARY_SUFFIX)" ./cmd/yukino

win32-arm64: CROSS_GOOS := windows
win32-arm64: CROSS_GOARCH := arm64
linux-arm64: CROSS_GOOS := linux
linux-arm64: CROSS_GOARCH := arm64
darwin-arm64: CROSS_GOOS := darwin
darwin-arm64: CROSS_GOARCH := arm64
win32-x64: CROSS_GOOS := windows
win32-x64: CROSS_GOARCH := amd64
linux-x64: CROSS_GOOS := linux
linux-x64: CROSS_GOARCH := amd64
darwin-x64: CROSS_GOOS := darwin
darwin-x64: CROSS_GOARCH := amd64

$(CROSS_TARGETS):
	@mkdir -p "$(BUILD_DIR)/$@"
	CGO_ENABLED=$(BUILD_CGO_ENABLED) GOOS=$(CROSS_GOOS) GOARCH=$(CROSS_GOARCH) $(GO) build $(BUILD_FLAGS) -ldflags "$(LDFLAGS)" -o "$(BUILD_DIR)/$@/yukino$(if $(filter windows,$(CROSS_GOOS)),.exe,)" ./cmd/yukino

cross-compile: $(CROSS_TARGETS)

.PHONY: test test-race vet fmt fmt-check check
test:
	$(GO) test $(TEST_FLAGS) ./...

test-race:
	$(GO) test -race $(TEST_FLAGS) ./...

vet:
	$(GO) vet ./...

fmt:
	$(GO) fmt ./...

fmt-check:
	@task_unformatted="$$(gofmt -l cmd internal)" || exit 1; \
	if [ -n "$$task_unformatted" ]; then \
		printf '%s\n' "$$task_unformatted"; \
		exit 1; \
	fi

check: fmt-check vet test-race check-scripts

.PHONY: check-terminal check-scripts
check-terminal: build
	$(NODE) scripts/check-terminal.mjs "$(BUILD_DIR)/yukino$(BINARY_SUFFIX)"

check-scripts:
	$(NODE) --check scripts/check-terminal.mjs
	$(NODE) --check scripts/generate-host-failures.mjs
