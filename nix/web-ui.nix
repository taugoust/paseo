# The browser web UI the daemon serves, built separately from the daemon. Its source is
# filtered to the app and the shared packages it bundles, so daemon-only changes reuse it.
{
  lib,
  buildNpmPackage,
  fetchNpmDeps,
  nodejs_22,
  npmDepsHash,
  version,
}:
let
  src = lib.cleanSourceWith {
    src = ./..;
    filter = import ./web-ui-source-filter.nix {
      inherit lib;
      root = ./..;
    };
  };
in
buildNpmPackage {
  pname = "paseo-web-ui";
  inherit version src;

  nodejs = nodejs_22;
  # Same name and hash as the daemon package's dependencies, so both share one store path.
  npmDeps = fetchNpmDeps {
    name = "paseo-${version}-npm-deps";
    inherit src;
    hash = npmDepsHash;
  };
  npmRebuildFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;

  # Install scripts are disabled in the sandbox. Apply the pinned upstream dependency patches.
  preBuild = ''
    npm run postinstall
    grep -F 'BottomSheetModalInternalProvider' node_modules/@gorhom/bottom-sheet/src/index.ts
    grep -F 'BottomSheetModalInternalProvider' node_modules/@gorhom/bottom-sheet/lib/module/index.js
  '';

  buildPhase = ''
    runHook preBuild
    npm run build:daemon-web-ui
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cp -r packages/server/dist/server/web-ui $out
    runHook postInstall
  '';

  dontFixup = true;
}
