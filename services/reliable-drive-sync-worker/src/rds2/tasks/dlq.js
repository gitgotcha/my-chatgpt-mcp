// RDS V2 dead-letter queue handling (Rev 6 plan T05). A DLQ message carries
// only a taskId; the authoritative task state always comes from D1. Completed
// tasks are acknowledged and left alone, needs_attention tasks are never
// auto-revived (admin replay is a separate, explicit entry), anything else
// live gets one normal dispatch attempt.
import { getTask } from "./repository.js";
import { dispatchOne } from "./dispatcher.js";

export async function handleDlq({ io, taskId, now }) {
  const task = await getTask(io.db, taskId);
  if (!task) return { outcome: "noop", taskId, code: "unknown_task" };
  if (task.state === "completed") return { outcome: "noop", taskId, code: null };
  if (task.state === "needs_attention") return { outcome: "noop", taskId, code: "needs_attention" };
  return dispatchOne({ io, taskId, owner: `dlq-${now}`, now });
}
