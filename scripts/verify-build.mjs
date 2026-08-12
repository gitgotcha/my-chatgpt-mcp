import { existsSync, readFileSync } from "node:fs";

const hook = JSON.parse(readFileSync("hooks/hooks.json", "utf8"));
const command = hook.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
if (typeof command !== "string") throw new Error("SessionStart hook command is missing");
const match = command.match(/packages\\mcp-server\\dist\\index\.js/);
if (!match || !existsSync("packages/mcp-server/dist/index.js")) {
  throw new Error("SessionStart hook target was not emitted by pnpm build");
}
if (!existsSync("packages/protocol/dist/event.js") || !existsSync("packages/protocol/dist/event.d.ts")) {
  throw new Error("Protocol runtime/types were not emitted by pnpm build");
}
console.log("build outputs and SessionStart hook target verified");
