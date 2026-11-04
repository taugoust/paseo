# Pi fork 0.15.0 verification

Source merge `d69c95eb36473011e5b74b3994e22ae2d28543ae` passes the checks and independent review below. This is PR evidence, not deployment or physical-device approval.

The [migration matrix](../pi-integration.md#0150-migration-audit) owns replacement and retention decisions. This record owns commands, observed results and limits.

## Scope and provenance

- Fork baseline: `2d56accd5d2b712a98edd0b83024c1a248ed4b86`, `origin/pi-integration`.
- Upstream: `v0.15.0`, peeled commit `8938fde3c713143f12eacbdd60c11fdfc0be0fb1`, annotated tag object `071cd7d943ca636b7a02b0b4e2e077849ae228f2`; release published 2026-11-03. Both remote tag refs were checked with `git ls-remote`; Git source comparisons peel the tag.
- Isolated branch: `pi/worker-1c9f80763248`, `/home/theo/.worktrees/paseo/pi-worker-1c9f80763248`. The shared checkout is not edited.
- Pre-port audit checkpoint: `ee2c85f303e8f90a4ca8886fe0b8b3489eb0b0b4`.
- Read-only integration sources were archived into the isolated tree's ignored `.dev/migration-validation/sources/`: bridge `bdc460dd05222d2ee72cc1e545b83935b5092253`, Accounts `72ee25805ac7aa762556b0551cfbac4fc2f3c401`, plugins `2c7104ba678582c88233660aec946786638bcad1`. Accounts' dirty checkout and recovery artifacts were not used or modified.
- The offline account-producer check reads Pi extensions `46f400d9bfd4d8323b0d3c7703881ff0fad41cce`. Its actual `openai-accounts/accounts.ts` SHA-256 is `82684a701ed03b4ddaa08f3f123f8ffcaac4463bea7ff028f93ae36c9367d17e`.

No user services were restarted, reloaded or deployed. Every daemon test used disposable state and an allocated loopback port; ordinary tests explicitly disable tmux-topology discovery. No full local test suite was run.

## Coordinator checks

All commands run from the isolated tree through `nix develop --command`, using Node 22. Tests are sequential within each command and bounded to named files or cases.

| Check                                                                   | Observed result                                                                                                                       | Raw evidence                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Protocol schema compatibility                                           | 18 passed                                                                                                                             | [protocol.log](pi-0.15.0/protocol.log)                                                              |
| Server wire compatibility                                               | 10 passed                                                                                                                             | [protocol.log](pi-0.15.0/protocol.log)                                                              |
| Real daemon legacy/native hooks and worktree setup                      | 5 passed; 10 unrelated cases excluded by name filter                                                                                  | [hooks-isolated.log](pi-0.15.0/hooks-isolated.log)                                                  |
| Compile bridge, Accounts and seven companion plugins with migrated host | All nine emit client and server bundles                                                                                               | [plugins.log](pi-0.15.0/plugins.log)                                                                |
| Compiled bridge Work/Goals/worktree/account guards                      | 46 passed, none skipped                                                                                                               | [plugins.log](pi-0.15.0/plugins.log)                                                                |
| Compiled Accounts registry and presentation                             | 9 passed, none skipped                                                                                                                | [plugins.log](pi-0.15.0/plugins.log)                                                                |
| Actual offline account producer                                         | Selected-provider/default changes, same model role, busy rejection, source/destination revision races and isolation assertions passed | [accounts-producer.log](pi-0.15.0/accounts-producer.log)                                            |
| Real Chromium plugin-panel journey                                      | 1 passed; wide/compact layouts, workspace/agent context, two hosts, routing, composer action, reload and unavailable state            | [browser-fonts.log](pi-0.15.0/browser-fonts.log), [result JSON](pi-0.15.0/browser-results.json.txt) |

### Protocol and native hook commands

```sh
npm test --workspace=@getpaseo/protocol -- src/messages.wire-compat.test.ts --bail=1 --maxWorkers=1 --no-file-parallelism
npm run test:unit --workspace=@getpaseo/server -- src/server/wire-compat.test.ts --bail=1 --maxWorkers=1 --no-file-parallelism
# Within packages/server, with PASEO_TMUX_TOPOLOGY=0:
node node_modules/vitest/vitest.mjs run src/server/plugins/lifecycle.e2e.test.ts --bail=1 --maxWorkers=1 --no-file-parallelism -t 'a plugin transforms workspace creation|addHook transforms workspace creation|worktree before hook rejects unsafe|the placement example creates|worktree includes reach'
```

The hook check starts real isolated daemons and plugin subprocesses. It exercises native `addHook`, retained legacy aliases, placement, unsafe-destination refusal and ignored-file copying before the first agent.

### Pinned plugin commands

Set `PASEO_PLUGIN_COMPILER=$PWD/packages/server/dist/server/server/plugins/compiler.js`, `PI_AGENT_EXTENSIONS_SOURCE=/home/theo/Workspace/pi-agent-extensions`, `PASEO_TMUX_TOPOLOGY=0` and `NODE_OPTIONS=--max-old-space-size=2048` inside the Nix shell.

```sh
node .dev/migration-validation/compile-plugins.mjs
node --experimental-strip-types --test --test-concurrency=1 \
  .dev/migration-validation/sources/bridge/plugin/test/compiled-work-tab.test.mjs \
  .dev/migration-validation/sources/bridge/plugin/test/compiled-delegated-goals.test.mjs \
  .dev/migration-validation/sources/bridge/plugin/test/compiled-workflows-guards.test.mjs \
  .dev/migration-validation/sources/bridge/plugin/test/compiled-worktree-filter.test.mjs \
  .dev/migration-validation/sources/bridge/plugin/test/compiled-chat-accounts.test.mjs
node --experimental-strip-types --test --test-concurrency=1 \
  .dev/migration-validation/sources/accounts/test/compiled-host-registry.mjs \
  .dev/migration-validation/sources/accounts/test/compiled-presentation.mjs
node --experimental-strip-types .dev/migration-validation/sources/accounts/test/provider-selection-producer.test.mjs /home/theo/Workspace/pi-agent-extensions
```

The [compile harness snapshot](pi-0.15.0/compile-plugins.mjs.txt) records the nine unmodified plugin entries. Compiled UI tests use small fake host/hook adapters; they are not device execution. The account-producer check executes the actual producer service with fixture model/context and an in-memory account store, temporary `HOME`/`TMPDIR`, and network forbidden. It does not exercise live credentials, OAuth, inference or user account changes.

### Browser command and visual evidence

Chromium came from `nix build --no-link --print-out-paths nixpkgs#chromium`, not a browser downloaded by npm. The [local Playwright override snapshot](pi-0.15.0/playwright.nix.config.ts.txt) uses the existing spec/global setup and an explicit Nix executable. Snapshots are evidence, not runnable modules from this documentation directory.

```sh
nix develop --command env \
  PASEO_TMUX_TOPOLOGY=0 \
  FONTCONFIG_FILE="$PWD/.dev/migration-validation/fonts.conf" \
  E2E_NIX_CHROMIUM=/nix/store/flqqsdvs8l0l86zwacyardqfi9ayz3qg-chromium-153.0.8010.52/bin/chromium \
  EXPO_PUBLIC_LOCAL_DAEMON=127.0.0.1:9 E2E_WORKERS=1 NODE_OPTIONS=--max-old-space-size=2048 \
  node node_modules/@playwright/test/cli.js test \
  --config .dev/migration-validation/playwright.nix.config.ts --project browser --workers 1 \
  packages/app/e2e/browser/plugin-workspace-panels.spec.ts
```

The default local endpoint is deliberately unreachable; the test seeds only its own two hosts. Screenshots show the test's minimal contributed panel, not the full Work plugin or a native device:

- [Wide workspace panel](pi-0.15.0/plugin-workspace-panel-wide.png)
- [Compact agent panel](pi-0.15.0/plugin-agent-panel-compact.png)

### Failed attempts and environment corrections

These failures were investigated, not counted as passes:

1. The first hook run inherited `PASEO_TMUX_TOPOLOGY=1` from the agent host. Its disposable daemon tried the host's tmux projection and failed workspace creation with `paseo-tmux-pane: command not found`. The [original failure](pi-0.15.0/hooks.log) is retained. Running with topology disabled passed. Generic Vitest/Nix checks now explicitly disable discovery; dedicated topology fixtures remain separate.
2. Headless Chromium initially had no fallback fonts. A standalone real-browser `setContent('<div>Font probe</div>')` measured text height `0`; with the [DejaVu Fontconfig file](pi-0.15.0/fonts.conf.txt), it measured `19`. The [fontless frame](pi-0.15.0/fontless-browser.jpg), [failed run](pi-0.15.0/browser.log) and [failure JSON](pi-0.15.0/browser-first-results.json.txt) are retained. The panel's text existed but had zero height. The later “Workspace unavailable” screenshot was taken after test cleanup removed its project, not proof of a product routing bug.
3. That first browser attempt also exposed a missing built CLI during teardown. After building the CLI, both leftover test daemons were stopped using their exact disposable `--home` paths ([cleanup output](pi-0.15.0/browser-cleanup.log)). The rerun reports both its daemon and Metro stopped cleanly. No existing service was stopped.

## Build, closure and final review

The [first installed-closure build](pi-0.15.0/nix-first-installed-failure.log) exposed a real migration defect: the native image splitter's public declaration imported its image DTO from the provider's Node-I/O module. Source compilation erased that type import; the installed compiler correctly followed the declaration graph and rejected `node:crypto`. The fix keeps the boundary strict, infers the pure image projection type and separates Node materialization from rendering. Declaration-graph checks now pass in both compiler-only and installed modes. The [initial dependency-hash attempt](pi-0.15.0/nix-initial-hash.log) is retained separately.

### Exact installed artifact

```sh
PASEO_TMUX_TOPOLOGY=0 nix build .#paseo --out-link /tmp/paseo-migration-result --print-build-logs
nix flake check --no-build
```

- Successful output: `/nix/store/f5cwiwlixbb871730kapm2d7z3x6bbzq-paseo-0.15.0`.
- Derivation: `/nix/store/y806c6yvshg886xd2rxp5pw9msf5x624-paseo-0.15.0.drv`.
- [Complete build/check/install output](pi-0.15.0/nix-build.log). The package's committed `nix/package.nix` records the exact focused checks; this is not a full repository-suite result.
- Build includes native addons, dependency patches, web assets, runtime tracing, retained licenses, 90 compiler cases, emitted Hermes/class-lowering checks and installed pure-presentation checks. Linux wrappers now include `procps`: native terminal identity/reaping needs `ps`, which the installed smoke showed was absent from the original closure.
- Installed terminal smoke verifies the worker bundle and shell assets, creates a real PTY, executes an assembled marker that cannot pass from shell echo, stops only its private daemon with `--keep-terminals`, reopens the same home, checks replay on the same terminal ID, and requires a new assembled marker from the surviving shell. It then kills that terminal and closes its private daemon. Output: `PASS installed Paseo daemon and terminal lifecycle: create, execute, restart, capture`.
- The sandbox smoke intentionally uses a non-Git directory. Its `spawn git ENOENT` warnings are not Git-feature coverage; checkout behavior is checked separately. Optional dependency/static-tracer warnings and the Node-only IndexedDB fixture warning remain visible in the raw log.
- [Flake evaluation](pi-0.15.0/flake-check.log) passes for x86_64 Linux, including default/daemon/desktop derivations, license assertions, modules and dev shell. `--no-build` does not claim a desktop build or other-system checks.

The corrected artifact was then used as `PASEO_PLUGIN_COMPILER` for the same nine integration entries, plus `compiled-work-tab.test.mjs`: all nine compiled and the installed-host Work lifecycle test passed ([raw installed-plugin evidence](pi-0.15.0/installed-plugins.log)). This is a separate installed-declaration/closure check, not a duplicate claim from the earlier source-host run.

### Focused source checks and quality

Raw worker evidence is retained for [Pi regressions](pi-0.15.0/paseo-pi-regressions.log), [images](pi-0.15.0/paseo-image-tests.log), [checkout/progress/compiler cases](pi-0.15.0/paseo-checkout-progress-compiler.log), [injected topology fixtures](pi-0.15.0/paseo-tmux-fixtures-fixed.log), [compiler-only declarations](pi-0.15.0/paseo-plugin-presentation-source.log) and [workspace-wide typecheck](pi-0.15.0/paseo-typecheck-final.log).

The first [topology fixture invocation](pi-0.15.0/paseo-tmux-fixtures.log) was invalid because source checkout paths lacked the installed package's adjacent `tmux-topology.ts`. Running copied tests beside that exact source with the actual compiled module passed 97 cases; no live tmux command was used. The compiler-only declaration test also preserves its documented `PASEO_PLUGIN_COMPILER`-without-`PASEO_INSTALL` invocation.

The focused source runs report 53 Pi cases passed (143 excluded by the name filter), 31 image cases passed, 156 checkout/progress/compiler/worktree cases passed and 97 injected topology cases passed. The 156-case group also contains one upstream-disabled macOS `/var` versus `/private/var` realpath test; it was not run and is not claimed as coverage.

Representative exact commands, with `PASEO_TMUX_TOPOLOGY=0` and `NODE_OPTIONS=--max-old-space-size=3072`:

```sh
node packages/server/node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers=1 \
  packages/server/src/server/agent/providers/provider-image-output.test.ts \
  packages/server/src/server/agent/providers/provider-image-output.posix.test.ts \
  packages/server/src/server/agent/providers/pi/tool-call-mapper.test.ts \
  packages/server/src/server/agent/providers/pi/tool-result-images.test.ts
node packages/server/node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers=1 \
  packages/server/src/server/agent/providers/pi/extensions/pi-progress.test.ts \
  packages/server/src/server/plugins/compiler.test.ts \
  packages/server/src/utils/checkout-git-ref-derived.test.ts \
  packages/server/src/utils/worktree.posix.test.ts
```

Final coordinator quality gate:

```sh
nix develop --command env PASEO_TMUX_TOPOLOGY=0 NODE_OPTIONS=--max-old-space-size=3072 \
  bash -c 'set -e; npm run format; npm run format:check; npm run lint; npm run typecheck'
```

[Raw final quality output](pi-0.15.0/final-quality.log): formatting passes across 5,636 files, lint reports zero warnings/errors across 5,167 files, and all workspace typechecks pass. No source diff remains after formatting; only the coordinator's documentation/evidence changes follow the reviewed source commit.

### Independent review

An independent reviewer inspected stable commit `d69c95eb36473011e5b74b3994e22ae2d28543ae` against both the original fork and peeled upstream release, including the corrected image/type boundary, terminal smoke, plugin boundaries and ownership-sensitive behavior. Final verdict: **no outstanding findings**. The P3 compiler-only test-path issue was fixed before final review. [Review record and full source hashes](pi-0.15.0/independent-review.txt) distinguish that source inspection from worker/coordinator runtime checks. The coordinator independently checked all 13 recorded hashes after the final formatter; all match.

## Platform and rollout limits

| Platform / behavior                                     | Coverage                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Linux x86_64 daemon/protocol/plugins                    | Targeted source and installed Nix checks above                                                                             |
| Browser web                                             | Real Chromium journey and screenshots; wide and compact viewports                                                          |
| iOS / Android                                           | Not run on a device or emulator; browser compact layout is not native evidence                                             |
| Electron Linux/macOS/Windows                            | No packaged desktop run; source/type validation is not packaged-app evidence                                               |
| Live Pi model, OAuth and native account quota endpoints | Not exercised; offline producer and deterministic provider boundaries only                                                 |
| User's installed mobile app                             | Wire compatibility and bundled-module policy checked; physical-device visual/gesture review remains a rollout prerequisite |

Merge/deployment require separate authorization. Before rollout, back up `config.json` and durable state, validate coordinated downstream pins, then review existing-device plugin controls and identity-sensitive operations. The first upgrade from 0.14 still closes its old terminals; persistent-worker preservation starts with 0.15. Keep native agent recovery off unless explicitly enabled; a recovery prompt is not Goal authorization. Before downgrading, restore the prior config backup or remove new resume/usage settings as described in the upstream release notes. Do not overwrite Accounts recovery artifacts or infer that earlier merged Nix MRs were deployed.
