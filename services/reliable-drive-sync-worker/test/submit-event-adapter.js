import { ProtocolError } from "../src/protocol.js";
import { dispatchSubmitEvent } from "../src/submit-event.js";

// Test-only adapter retained so the domain regression suite can exercise the
// old JSON-RPC-shaped fixtures without keeping a remote MCP endpoint in the
// deployed Worker.
export async function handleRequest(request, env, deps = {}) {
  const message = await request.json();
  try {
    const value = await dispatchSubmitEvent(env, message.params?.arguments ?? {}, deps);
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: JSON.stringify(value) }] }
    });
  } catch (cause) {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: cause instanceof ProtocolError ? -32602 : -32603,
        message: cause instanceof Error ? cause.message : String(cause)
      }
    });
  }
}
