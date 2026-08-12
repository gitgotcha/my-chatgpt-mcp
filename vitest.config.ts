import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/** Tests resolve protocol TypeScript directly, so a clean checkout never relies on ignored dist output. */
export default defineConfig({
  resolve: {
    alias: [
      { find: "@reliable-drive-sync/protocol/event", replacement: `${root}packages/protocol/src/event.ts` },
      { find: "@reliable-drive-sync/protocol/result", replacement: `${root}packages/protocol/src/result.ts` }
    ]
  }
});
