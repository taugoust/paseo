# Source filter for the browser web UI. It keeps only what the Expo web export reads, so a
# change to the server, CLI, plugins or Nix tests leaves the web UI derivation unchanged and
# reusable from the store. `root` is the repository root.
{ lib, root }:
path: type:
let
  baseName = builtins.baseNameOf path;
  relPath = lib.removePrefix (toString root) path;
  # Workspaces the web export builds and bundles, kept in full.
  bundled = [
    "app"
    "protocol"
    "client"
    "relay"
    "highlight"
    "plugin"
    "expo-two-way-audio"
  ];
  bundledPrefixes = map (name: "/packages/${name}/") bundled;
  rootFiles = [
    "/package.json"
    "/package-lock.json"
    "/tsconfig.base.json"
    "/tsconfig.json"
    "/scripts/build-daemon-web-ui.mjs"
    "/scripts/postinstall-patches.mjs"
    # npm needs every workspace's manifest to resolve the workspace layout.
    "/plugins/package.json"
  ];
  directories = [
    ""
    "/packages"
    "/scripts"
    "/plugins"
  ];
  excluded =
    baseName == "node_modules"
    || baseName == ".git"
    || baseName == ".expo"
    || baseName == "dist"
    || baseName == ".DS_Store"
    || lib.hasPrefix "/packages/app/android" relPath
    || lib.hasPrefix "/packages/app/ios" relPath
    || lib.hasPrefix "/packages/app/e2e" relPath
    || lib.hasPrefix "/packages/app/maestro" relPath
    || lib.hasPrefix "/packages/app/fastlane" relPath
    # Tests never reach the bundle.
    || builtins.match ".*\\.(test|spec)\\.[cm]?[jt]sx?" baseName != null;
in
!excluded
&& (
  lib.elem relPath rootFiles
  || (type == "directory" && lib.elem relPath directories)
  || lib.hasPrefix "/patches" relPath
  || lib.any (prefix: lib.hasPrefix prefix relPath || relPath + "/" == prefix) bundledPrefixes
  # Other workspaces contribute only their directory and manifest.
  || builtins.match "/packages/[^/]+" relPath != null && type == "directory"
  || builtins.match "/packages/[^/]+/package\\.json" relPath != null
)
