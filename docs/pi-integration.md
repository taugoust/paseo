# Pi integration fork

`pi-integration` starts at upstream `cafe4b01c8522ff39560241c5deb01427dc8dc5b` (0.12.0), the deployed baseline. Keep migration of downstream changes separate from upstream upgrades. Leave `main` available for upstream tracking; merge upgrades deliberately and rerun compatibility checks.

Application changes and their regression tests belong in this repository, not in the Nix configuration's patch stack. The fork's Nix package owns dependency patches, runtime closure tracing and native-addon installation. Downstream Nix selects the revision, supplies host configuration and runs integration checks against the actual built host and plugin sources.

## Existing client compatibility

Installing a new daemon does not update the iPad/mobile apps. Preserve their existing protocol and plugin SDK contract. Visual changes must work consistently on web and installed native clients without requiring an app update.

Expose reusable implementation through bundled libraries when installed clients cannot provide a new runtime SDK module. The daemon compiler bundles `@getpaseo/highlight` with its grammars and the dependency-free helpers in `@getpaseo/plugin/shared`; neither is a client-host SDK import. Native app source and plugin adapters share highlighting, spinner state and markdown metrics. Quota adapters share pure normalization while retaining their validation/output policies, credential transport and session/account identity guards. Keep compiler runtime-boundary checks intact, including transitive imports. Keep Hermes class/interop lowering in the compiler and test the emitted bundle, not only the TypeScript source.

Pi-specific transcript and account adapters remain in the plugins. They must not copy native application internals or import app-private contexts. The companion account plugin owns the composer account control; the bridge owns Work/btw and Pi transport integration.

## Release discipline

Run targeted regression suites and installed-closure checks. Keep builds sequential and memory constrained: a previous unconstrained build OOM-killed a live Pi session. Do not restart protected Pi processes during activation. Verify the served plugin bundle, intended controls and menu behavior after deployment. Browser screenshots and Hermes compilation are useful evidence, but neither proves native-device execution.
