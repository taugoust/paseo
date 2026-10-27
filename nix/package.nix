{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_22,
  python3,
  makeWrapper,
  autoPatchelfHook,
  # node-pty needs libuv headers on Linux
  libuv,
  # Exposed so downstream flakes that follow a different nixpkgs revision
  # (where `fetchNpmDeps` may produce a different hash for the same lockfile)
  # can override via `.override { npmDepsHash = "sha256-..."; }` without
  # `overrideAttrs` gymnastics — `npmDepsHash` is destructured from
  # `buildNpmPackage`'s args, so `overrideAttrs` cannot reach it.
  #
  # The default is read from a sidecar file so the CI auto-updater can replace
  # the hash with a single file write instead of a sed against this source.
  npmDepsHash ? lib.fileContents ./npm-deps.hash,
}:

buildNpmPackage rec {
  pname = "paseo";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  src = lib.cleanSourceWith {
    src = ./..;
    filter =
      path: type:
      let
        baseName = builtins.baseNameOf path;
        relPath = lib.removePrefix (toString ./..) path;
      in
      # Exclude non-daemon workspace contents (keep package.json for workspace resolution)
      !(lib.hasPrefix "/packages/app/android" relPath)
      && !(lib.hasPrefix "/packages/app/ios" relPath)
      && !(lib.hasPrefix "/packages/website/src" relPath)
      && !(lib.hasPrefix "/packages/website/public" relPath)
      && !(lib.hasPrefix "/packages/desktop/src" relPath)
      && !(lib.hasPrefix "/packages/desktop/src-tauri" relPath)
      # Documentation, CI definitions and agent/editor configuration. None of
      # these reach the build. Excluding them here also matters for the desktop
      # derivation, which inherits this package's npmDeps: leaving them in makes
      # a docs-only commit produce a new npm-deps .drv, and so a new desktop
      # .drv, and so a full rebuild for a byte-identical result.
      && !(lib.hasPrefix "/docs" relPath)
      && !(lib.hasPrefix "/.github" relPath)
      && !(lib.hasPrefix "/.agents" relPath)
      && !(lib.hasPrefix "/.claude" relPath)
      && !(lib.hasPrefix "/.codex" relPath)
      && !(lib.hasPrefix "/docker" relPath)
      # Top-level prose only (README, CHANGELOG, AGENTS...). Deeper markdown is
      # not necessarily documentation: skills/*/SKILL.md is a runtime file the
      # daemon's trace script copies into the output.
      && builtins.match "/[^/]+\\.md" relPath == null
      # Keep unit tests in the derivation source: the Nix check phase runs
      # focused fork-owned behavioral suites against the built packages.
      && !(lib.hasSuffix ".e2e.test.ts" baseName)
      && baseName != "node_modules"
      && baseName != ".npm-logs"
      && baseName != ".git"
      && baseName != ".paseo"
      && baseName != ".DS_Store";
  };

  nodejs = nodejs_22;
  # Bound individual compiler heaps; release builds also use a memory-capped scope.
  NODE_OPTIONS = "--max-old-space-size=3072";

  # Default hash lives in nix/npm-deps.hash (see arg default above).
  # CI auto-updates that file when package-lock.json changes (see .github/workflows/).
  inherit npmDepsHash;

  # Prevent onnxruntime-node's install script from running during automatic
  # npm rebuild (it tries to download from api.nuget.org, which fails in the sandbox).
  # We manually rebuild only node-pty in buildPhase.
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    python3 # for node-gyp (node-pty compilation)
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    autoPatchelfHook
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    libuv
    stdenv.cc.cc.lib # libstdc++ for sherpa-onnx prebuilt binaries
  ];

  # Don't use the default npm build/check hooks — Nix runs a focused set of
  # fork-owned behavioral checks after building the daemon workspaces.
  dontNpmBuild = true;
  doCheck = true;
  # Live tmux integration belongs to the downstream bridge/topology check,
  # not the standalone Paseo package's build or test dependencies.

  checkPhase = ''
    runHook preCheck
    node --test nix/tests/source-filter.test.mjs
    export PASEO_BUILD="$PWD"
    export PASEO_INSTALL="$PWD"
    export PASEO_SOURCE="$PWD"
    export PASEO_SUBAGENT_STORE_MODULE="$PWD/packages/server/dist/server/server/agent/provider-subagents/store.js"
    export PASEO_TOPOLOGY_COMPILED=1
    export TYPESCRIPT_PATH="$PWD/node_modules/typescript"
    mkdir -p "$TMPDIR/paseo-tests"
    cp -r nix/tests/. "$TMPDIR/paseo-tests/"
    cd "$TMPDIR/paseo-tests"
    node --experimental-test-module-mocks --test --test-concurrency=1 cli-workspace-ids.test.mjs pi-reaped-subagents.test.mjs pi-child-notifications.test.mjs pi-import-selection.test.mjs pi-progress.test.mjs quiet-harness-messages.test.mjs generic-tool-presentation.test.mjs pi-added-task-detail.test.mjs
    node --experimental-vm-modules --test --test-concurrency=1 generic-tool-components.test.mjs
    node native-tool-error.test.mjs "$PASEO_INSTALL/packages/server/dist/server/server/agent/providers/pi/native-tool-error.js"
    node native-subagent-links.test.mjs "$PASEO_INSTALL/packages/server/dist/server/server/agent/providers/pi/extensions/pi-subagents/native-subagent-links.js"
    node replacement-settlement.test.mjs "$PASEO_INSTALL/packages/server/dist/server/server/agent/agent-manager.js"
    node tool-error-content.test.mjs "$PASEO_INSTALL/packages/protocol/dist/tool-call-display.js"
    node task-outcomes.test.mjs "$PASEO_INSTALL/packages/server/dist/server/server/agent/providers/pi/tool-call-mapper.js"
    node pi-web-search-detail.test.mjs "$PASEO_INSTALL/packages/server/dist/server/server/agent/providers/pi/tool-call-mapper.js"
    node pi-questionnaire-adapter.test.mjs "$PASEO_INSTALL" questionnaire-input.json
    cd "$PASEO_BUILD"
    node packages/server/node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers=1 --exclude "**/*.e2e.test.ts" src/server/agent/providers/pi/agent.test.ts src/server/agent/providers/pi/cli-runtime.test.ts src/server/agent/providers/pi/tool-result-images.test.ts src/server/agent/providers/pi/usage-lifecycle.test.ts -t "permission modes refresh live state|bridge state explicitly|bridge metadata is absent|auto-compaction|extension command|Pi extension errors|extension_error|questionnaire|idle usage|idle refresh|actual final usage|compact|compaction|configured RPC timeout|admission|human command|human input|Pi tool result|tool images|routes native subagent snapshots"
    npm test --workspace=@getpaseo/builtin-plugins -- codex-usage-source/server
    npm test --workspace=@getpaseo/plugin -- src/shared
    npm test --workspace=@getpaseo/app -- src/components/markdown/renderer.test.ts src/components/synced-loader-state.test.ts
    node packages/server/node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers=1 src/server/plugins/compiler.test.ts
    runHook postCheck
  '';

  # Install scripts are disabled in the sandbox. Apply the pinned upstream
  # dependency patches explicitly, matching development and retaining parser fixes.
  preBuild = ''
    npm run postinstall
    grep -F 'BottomSheetModalInternalProvider' node_modules/@gorhom/bottom-sheet/src/index.ts
    grep -F 'BottomSheetModalInternalProvider' node_modules/@gorhom/bottom-sheet/lib/module/index.js
  '';

  buildPhase = ''
    runHook preBuild

    # Rebuild only node-pty (native addon for terminal emulation). The sherpa
    # speech runtime ships prebuilt platform packages and is copied into the
    # daemon closure by scripts/trace-daemon.mjs.
    npm rebuild node-pty

    # Build all server packages in dependency order (defined in package.json)
    npm run build:server
    npm run build:daemon-web-ui

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Compute the daemon's runtime closure by static module-graph tracing
    # (@vercel/nft from supervisor-entrypoint.js, cli/dist/index.js, and the
    # forked terminal/speech worker processes) plus an explicit list of non-JS
    # assets read at runtime. The trace script is the single source of
    # truth for what the daemon needs at $out — auditable in plain JS, no
    # npm hoisting / .bin / workspace-symlink footguns.
    mkdir -p $out/lib/paseo
    node scripts/trace-daemon.mjs > daemon-files.txt

    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$out/lib/paseo/$(dirname "$path")"
      cp -a "$path" "$out/lib/paseo/$path"
    done < daemon-files.txt

    # Shell hooks invoke the retained CLI bin directly, without a system Node.
    patchShebangs --build "$out/lib/paseo"

    # Root package.json lets node resolve the workspace layout when the
    # CLI/server bin starts from $out.
    cp package.json $out/lib/paseo/

    # Web UI Assets
    cp -r packages/server/dist/server/web-ui $out/lib/paseo/packages/server/dist/server/

    # Create wrapper for the server entry point (for systemd / direct use)
    mkdir -p $out/bin
    # Keep Paseo's runtime mode separate from NODE_ENV, which belongs to spawned agents.
    makeWrapper ${nodejs}/bin/node $out/bin/paseo-server \
      --add-flags "$out/lib/paseo/packages/server/dist/scripts/supervisor-entrypoint.js" \
      --set PASEO_NODE_ENV production

    # Create wrapper for the CLI
    makeWrapper ${nodejs}/bin/node $out/bin/paseo \
      --add-flags "$out/lib/paseo/packages/cli/dist/index.js" \
      --set NODE_PATH "$out/lib/paseo/node_modules"

    # Retain fork-owned Nix behavioral tests for independent downstream checks.
    mkdir -p "$out/lib/paseo/nix"
    cp -r nix/tests "$out/lib/paseo/nix/"
    cp packages/server/src/server/tmux-topology.ts "$out/lib/paseo/nix/tests/tmux-topology.ts"

    # Preserve the exact installed sources used by the downstream hermetic
    # component checks, along with the Babel license notices.
    mkdir -p "$out/lib/paseo/licenses"
    cp node_modules/@babel/core/LICENSE "$out/lib/paseo/licenses/BABEL-CORE-MIT.txt"
    cp node_modules/@babel/plugin-transform-classes/LICENSE "$out/lib/paseo/licenses/BABEL-CLASSES-MIT.txt"
    node nix/copy-highlight-licenses.mjs "$PWD" "$out/lib/paseo/licenses/highlight" "$out/lib/paseo"
    node nix/tests/highlight-licenses.test.mjs "$out/lib/paseo/licenses/highlight"
    # NFT traces runtime files, not type-only imports of bundled shared helpers.
    mkdir -p "$out/lib/paseo/packages/plugin/dist/shared"
    cp packages/plugin/dist/shared/*.d.ts "$out/lib/paseo/packages/plugin/dist/shared/"
    mkdir -p "$out/lib/paseo/packages/app/src/components"
    cp packages/app/src/components/tool-call-details.tsx \
      "$out/lib/paseo/packages/app/src/components/tool-call-details.tsx"
    cp packages/app/src/components/message.tsx "$out/lib/paseo/packages/app/src/components/message.tsx"
    mkdir -p "$out/lib/paseo/packages/app/src/types"
    cp packages/app/src/types/stream.ts "$out/lib/paseo/packages/app/src/types/stream.ts"
    cp -r packages/server/node_modules/node-pty/prebuilds \
      "$out/lib/paseo/packages/server/node_modules/node-pty/"

    node nix/tests/plugin-hermes-classes.test.mjs \
      "$out/lib/paseo/packages/server/dist/server/server/plugins/compiler.js"

    runHook postInstall
  '';

  meta = {
    description = "Self-hosted daemon for Claude Code, Codex, and OpenCode";
    homepage = "https://github.com/getpaseo/paseo";
    license = lib.licenses.asl20;
    mainProgram = "paseo";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
