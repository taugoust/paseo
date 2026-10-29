# Pi integration fork

`pi-integration` started at upstream `cafe4b01c8522ff39560241c5deb01427dc8dc5b` (0.12.0). The current upgrade target is `8c6de842a3157530c26a7a94c78a3d647fb96ce9` (0.14.0); preparing this merge does not change the deployed baseline. Keep migration of downstream changes separate from upstream upgrades. Leave `main` available for upstream tracking; merge upgrades deliberately and rerun compatibility checks.

Application changes and their regression tests belong in this repository, not in the Nix configuration's patch stack. The fork's Nix package owns dependency patches, runtime closure tracing and native-addon installation. Downstream Nix selects the revision, supplies host configuration and runs integration checks against the actual built host and plugin sources.

## Existing client compatibility

Installing a new daemon does not update the iPad/mobile apps. Preserve their existing protocol and plugin SDK contract. Visual changes must work consistently on web and installed native clients without requiring an app update.

Expose reusable implementation through bundled libraries when installed clients cannot provide a new runtime SDK module. The daemon compiler bundles `@getpaseo/highlight` with its grammars and the dependency-free helpers in `@getpaseo/plugin/shared`; neither is a client-host SDK import. Native app source and plugin adapters share highlighting, spinner state and markdown metrics. The compiler also bundles the existing pure public generic/Paseo presentation and tool-call display modules. A narrow `@getpaseo/server/pi-tool-presentation` entry reexports the unchanged Pi argument/result parser, detail mapper and native error helper, so plugin adapters share actual native classification/label/error policy without importing app components or requiring a client SDK update. Other server-package client imports, alias traversal, unreviewed presentation dependencies, ambient I/O and dynamic loading remain rejected. Keep transport decoding, bounded media-safe projections and specialized file/diff surfaces in the bridge; do not treat these presentation helpers as authorization or navigation metadata. Quota adapters share pure normalization while retaining their validation/output policies, credential transport and session/account identity guards. Keep compiler runtime-boundary checks intact, including transitive imports. Keep Hermes class/interop lowering in the compiler and test the emitted bundle, not only the TypeScript source.

Pi-specific transcript and account adapters remain in the plugins. They must not copy native application internals or import app-private contexts. The companion account plugin owns the composer account control; the bridge owns Work/btw and Pi transport integration.

## Managed tmux launch visibility

Worker visibility needs a coordinated host and `pi-agent-extensions` launcher update. The host
projects a new tmux window while it still contains the launch-gate shell, before Pi starts or the
bridge can import its agent. Publish verifiable launch intent before creating that pane; later
runtime records and pane options cannot prevent the first foreground publication. Keep this
pre-import topology evidence separate from the bridge's stricter agent-bound notification identity.

## Release discipline

Run targeted regression suites and installed-closure checks. Keep builds sequential and memory constrained: a previous unconstrained build OOM-killed a live Pi session. Do not restart protected Pi processes during activation. Verify the served plugin bundle, intended controls and menu behavior after deployment. Browser screenshots and Hermes compilation are useful evidence, but neither proves native-device execution.
