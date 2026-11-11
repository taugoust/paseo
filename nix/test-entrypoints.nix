# Stable names for installed paths that downstream integration checks load. Paths are relative
# to the package output. The install phase fails if any is missing, so a layout change is fixed
# here rather than in each consumer.
let
  install = "lib/paseo";
  server = "${install}/packages/server/dist/server/server";
  piSubagents = "${server}/agent/providers/pi/extensions/pi-subagents";
in
{
  inherit install;
  tests = "${install}/nix/tests";
  nodeModules = "${install}/node_modules";
  agentManager = "${server}/agent/agent-manager.js";
  pluginCompiler = "${server}/plugins/compiler.js";
  providerSubagentStore = "${server}/agent/provider-subagents/store.js";
  piSubagentAdapter = "${piSubagents}/index.js";
  piNativeSubagentLinks = "${piSubagents}/native-subagent-links.js";
  protocolPackage = "${install}/packages/protocol";
  toolCallDisplay = "${install}/packages/protocol/dist/tool-call-display.js";
}
