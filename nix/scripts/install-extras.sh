# Copies files the traced daemon closure doesn't include but downstream checks need.
# Usage: install-extras.sh <install dir>, run from the build directory.
set -euo pipefail

install="$1"

# Copies each source file to the same relative path under the install directory.
keep() {
  local file
  for file in "$@"; do
    mkdir -p "$install/$(dirname "$file")"
    cp "$file" "$install/$file"
  done
}

# Fork-owned Nix behavioral tests, for independent downstream checks.
mkdir -p "$install/nix"
cp -r nix/tests "$install/nix/"
cp packages/server/src/server/tmux-topology.ts "$install/nix/tests/tmux-topology.ts"

# License notices for the installed sources the downstream component checks use.
mkdir -p "$install/licenses"
cp node_modules/@babel/core/LICENSE "$install/licenses/BABEL-CORE-MIT.txt"
cp node_modules/@babel/plugin-transform-classes/LICENSE "$install/licenses/BABEL-CLASSES-MIT.txt"
node nix/copy-highlight-licenses.mjs "$PWD" "$install/licenses/highlight" "$install"

# NFT traces runtime files, not type-only imports of bundled shared helpers.
keep packages/plugin/dist/shared/*.d.ts
pi_dist=packages/server/dist/server/server/agent/providers/pi
keep \
  "$pi_dist/tool-presentation.d.ts" \
  "$pi_dist/tool-call-mapper.d.ts" \
  "$pi_dist/native-tool-error.d.ts" \
  "$pi_dist/extensions/pi-subagents/presentation.d.ts"

# The exact app sources the downstream hermetic component checks compile.
keep \
  packages/app/src/components/tool-call-details.tsx \
  packages/app/src/components/message.tsx \
  packages/app/src/types/stream.ts

cp -r packages/server/node_modules/node-pty/prebuilds \
  "$install/packages/server/node_modules/node-pty/"
