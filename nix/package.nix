{
  lib,
  stdenv,
  buildNpmPackage,
  fetchNpmDeps,
  nodejs_22,
  python3,
  makeWrapper,
  autoPatchelfHook,
  procps,
  # node-pty needs libuv headers on Linux
  libuv,
  # Exposed so downstream flakes on another nixpkgs revision, where `fetchNpmDeps` may hash the
  # same lockfile differently, can use `.override { npmDepsHash = "sha256-..."; }`. It is
  # destructured from `buildNpmPackage`'s args, so `overrideAttrs` cannot reach it. The default
  # lives in a sidecar file so the CI auto-updater can replace it with a single file write.
  npmDepsHash ? lib.fileContents ./npm-deps.hash,
  # The behavioral test suites. Off for the package itself so deploys only build; the flake's
  # `checks.paseo` builds with them on.
  runTests ? false,
}:

let
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  webUi = import ./web-ui.nix {
    inherit
      lib
      buildNpmPackage
      fetchNpmDeps
      nodejs_22
      npmDepsHash
      version
      ;
  };
  testEntrypoints = import ./test-entrypoints.nix;
  procpsPath = lib.optionalString stdenv.hostPlatform.isLinux "--prefix PATH : ${procps}/bin";
in
buildNpmPackage rec {
  pname = "paseo";
  inherit version;

  src = lib.cleanSourceWith {
    src = ./..;
    filter = import ./source-filter.nix {
      inherit lib;
      root = ./..;
    };
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
    procps # terminal workers inspect their own process identity with `ps`
    stdenv.cc.cc.lib # libstdc++ for sherpa-onnx prebuilt binaries
  ];

  # Don't use the default npm build/check hooks. Nix runs a focused set of fork-owned behavioral
  # checks after building the daemon workspaces. Live tmux integration belongs to the downstream
  # bridge/topology check, not this package's build or test dependencies.
  dontNpmBuild = true;
  doCheck = runTests;
  doInstallCheck = runTests;

  checkPhase = ''
    runHook preCheck
    bash nix/scripts/check.sh
    runHook postCheck
  '';

  # Install scripts are disabled in the sandbox. Apply the pinned upstream
  # dependency patches explicitly, matching development and retaining parser fixes.
  preBuild = ''
    npm run postinstall
  '';

  buildPhase = ''
    runHook preBuild

    # Rebuild only node-pty (native addon for terminal emulation). The sherpa
    # speech runtime ships prebuilt platform packages and is copied into the
    # daemon closure by scripts/trace-daemon.mjs.
    npm rebuild node-pty

    # Build all server packages in dependency order (defined in package.json)
    npm run build:server
    # The web UI is its own derivation, rebuilt only when the app or its packages change.
    mkdir -p packages/server/dist/server
    cp -r ${webUi} packages/server/dist/server/web-ui
    chmod -R u+w packages/server/dist/server/web-ui

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Compute the daemon's runtime closure by static module-graph tracing (@vercel/nft from
    # supervisor-entrypoint.js, cli/dist/index.js and the forked terminal/speech workers), plus an
    # explicit list of non-JS assets read at runtime. The trace script is the single source of
    # truth for what the daemon needs at $out.
    mkdir -p $out/lib/paseo
    node scripts/trace-daemon.mjs > daemon-files.txt
    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$out/lib/paseo/$(dirname "$path")"
      cp -a "$path" "$out/lib/paseo/$path"
    done < daemon-files.txt

    # Shell hooks invoke the retained CLI bin directly, without a system Node.
    patchShebangs --build "$out/lib/paseo"

    # Root package.json lets node resolve the workspace layout when the CLI/server starts.
    cp package.json $out/lib/paseo/
    cp -r packages/server/dist/server/web-ui $out/lib/paseo/packages/server/dist/server/

    # Paseo's runtime mode stays separate from NODE_ENV, which belongs to spawned agents.
    mkdir -p $out/bin
    makeWrapper ${nodejs}/bin/node $out/bin/paseo-server \
      --add-flags "$out/lib/paseo/packages/server/dist/scripts/supervisor-entrypoint.js" \
      --set PASEO_NODE_ENV production \
      ${procpsPath}
    makeWrapper ${nodejs}/bin/node $out/bin/paseo \
      --add-flags "$out/lib/paseo/packages/cli/dist/index.js" \
      --set NODE_PATH "$out/lib/paseo/node_modules" \
      ${procpsPath}

    bash nix/scripts/install-extras.sh "$out/lib/paseo"

    runHook postInstall
  '';

  installCheckPhase = ''
    runHook preInstallCheck
    ${lib.optionalString (stdenv.hostPlatform.isLinux && stdenv.hostPlatform.isx86_64) ''
      export HERMESC="$PWD/node_modules/hermes-compiler/hermesc/linux64-bin/hermesc"
    ''}
    bash nix/scripts/install-checks.sh "$out" ${
      lib.escapeShellArgs (lib.mapAttrsToList (name: path: "${name}=${path}") testEntrypoints)
    }
    runHook postInstallCheck
  '';

  passthru = {
    inherit testEntrypoints webUi;
  };

  meta = {
    description = "Self-hosted daemon for Claude Code, Codex, and OpenCode";
    homepage = "https://github.com/getpaseo/paseo";
    license = lib.licenses.asl20;
    mainProgram = "paseo";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
