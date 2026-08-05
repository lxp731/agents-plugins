import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function exitCommand(pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Exit the application (alias for /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
