# Checks the installed package. Run from the build directory.
# Usage: install-checks.sh <output> <name=relative path>...
# Each name=path pair is a test entrypoint that must exist under the output.
set -euo pipefail

out="$1"
shift
install="$out/lib/paseo"

node nix/tests/highlight-licenses.test.mjs "$install/licenses/highlight"
node nix/tests/plugin-hermes-classes.test.mjs \
  "$install/packages/server/dist/server/server/plugins/compiler.js"
PASEO_INSTALL="$install" node --test nix/tests/plugin-bundled-tool-presentation.test.mjs
PASEO_INSTALL="$install" node nix/tests/installed-daemon-smoke.mjs "$out/bin/paseo"

for entry in "$@"; do
  name="${entry%%=*}"
  path="${entry#*=}"
  test -e "$out/$path" || { echo "test entrypoint $name is missing: $path" >&2; exit 1; }
done
