# Fork-owned behavioral checks, run by the Nix check phase from the build directory.
set -euo pipefail

build="$PWD"
server_dist="$build/packages/server/dist/server/server"
pi_dist="$server_dist/agent/providers/pi"

# Generic fixture daemons must not inspect the builder's live tmux session. Dedicated tmux tests
# opt in with their own isolated fixture environment.
export PASEO_TMUX_TOPOLOGY=0
node --test nix/tests/source-filter.test.mjs

export PASEO_BUILD="$build"
export PASEO_INSTALL="$build"
export PASEO_SOURCE="$build"
export PASEO_SUBAGENT_STORE_MODULE="$server_dist/agent/provider-subagents/store.js"
export PASEO_TOPOLOGY_COMPILED=1
export TYPESCRIPT_PATH="$build/node_modules/typescript"

# The Nix test suites run from a writable copy.
mkdir -p "$TMPDIR/paseo-tests"
cp -r nix/tests/. "$TMPDIR/paseo-tests/"
cd "$TMPDIR/paseo-tests"

mocked_tests=(
  cli-workspace-ids.test.mjs
  pi-reaped-subagents.test.mjs
  pi-child-notifications.test.mjs
  pi-import-selection.test.mjs
  pi-progress.test.mjs
  quiet-harness-messages.test.mjs
  generic-tool-presentation.test.mjs
  subagent-task-summary.test.mjs
  pi-added-task-detail.test.mjs
)
node --experimental-test-module-mocks --test --test-concurrency=1 "${mocked_tests[@]}"
node --experimental-vm-modules --test --test-concurrency=1 generic-tool-components.test.mjs
node native-tool-error.test.mjs "$pi_dist/native-tool-error.js"
node native-subagent-links.test.mjs "$pi_dist/extensions/pi-subagents/native-subagent-links.js"
node replacement-settlement.test.mjs "$server_dist/agent/agent-manager.js"
node tool-error-content.test.mjs "$build/packages/protocol/dist/tool-call-display.js"
node task-outcomes.test.mjs "$pi_dist/tool-call-mapper.js"
node pi-web-search-detail.test.mjs "$pi_dist/tool-call-mapper.js"
node pi-questionnaire-adapter.test.mjs "$build" questionnaire-input.json
cd "$build"

vitest() {
  node packages/server/node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers=1 "$@"
}

pi_suites=(
  src/server/agent/providers/pi/agent.test.ts
  src/server/agent/providers/pi/cli-runtime.test.ts
  src/server/agent/providers/pi/tool-result-images.test.ts
  src/server/agent/providers/pi/usage-lifecycle.test.ts
)
pi_tests=(
  "permission modes refresh live state"
  "bridge state explicitly"
  "bridge metadata is absent"
  "auto-compaction"
  "extension command"
  "Pi extension errors"
  "extension_error"
  "questionnaire"
  "idle usage"
  "idle refresh"
  "actual final usage"
  "compact"
  "compaction"
  "configured RPC timeout"
  "admission"
  "human command"
  "human input"
  "Pi tool result"
  "tool images"
  "routes native subagent snapshots"
)
pi_pattern="$(IFS='|'; echo "${pi_tests[*]}")"
vitest --exclude "**/*.e2e.test.ts" "${pi_suites[@]}" -t "$pi_pattern"

npm test --workspace=@getpaseo/builtin-plugins -- \
  codex-usage-source/server claude-usage-source/server
npm test --workspace=@getpaseo/plugin -- src/shared
npm test --workspace=@getpaseo/app -- \
  src/components/markdown/renderer.test.ts src/components/synced-loader-state.test.ts
vitest src/server/plugins/compiler.test.ts
