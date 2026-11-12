# Source filter for the daemon package. `root` is the repository root.
{ lib, root }:
path: _type:
let
  baseName = builtins.baseNameOf path;
  relPath = lib.removePrefix (toString root) path;
  # Non-daemon workspace contents. Their package.json files stay for workspace resolution.
  excludedPrefixes = [
    "/packages/app/android"
    "/packages/app/ios"
    "/packages/website/src"
    "/packages/website/public"
    "/packages/desktop/src"
    "/packages/desktop/src-tauri"
    # Documentation, CI definitions and agent/editor configuration. None of these reach the
    # build. Excluding them also matters for the desktop derivation, which inherits this
    # package's npmDeps: leaving them in makes a docs-only commit produce a new npm-deps .drv,
    # and so a new desktop .drv, and so a full rebuild for a byte-identical result.
    "/docs"
    "/.github"
    "/.agents"
    "/.claude"
    "/.codex"
    "/docker"
  ];
in
!(lib.any (prefix: lib.hasPrefix prefix relPath) excludedPrefixes)
# Top-level prose only (README, CHANGELOG, AGENTS...). Deeper markdown is not necessarily
# documentation: skills/*/SKILL.md is a runtime file the daemon's trace script copies.
&& builtins.match "/[^/]+\\.md" relPath == null
# Keep unit tests in the derivation source: the check phase runs focused fork-owned suites.
&& !(lib.hasSuffix ".e2e.test.ts" baseName)
&& baseName != "node_modules"
&& baseName != ".npm-logs"
&& baseName != ".git"
&& baseName != ".paseo"
&& baseName != ".DS_Store"
