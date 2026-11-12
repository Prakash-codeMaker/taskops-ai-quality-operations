import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["POST"];

export default async function (req, res) {
  const taskId = String(req.params.id || "");
  const reviewerId = String(req.body?.reviewer_id || "");
  const actor = req.user?.email || "authenticated-user";

  if (!taskId || !reviewerId) {
    return res.status(400).json({ error: "Task and reviewer are required." });
  }

  try {
    const workspace = await requireWorkspace(req, res);
    if (!workspace) return;
    if (!requireRole(workspace, res, ["owner","admin","quality_lead"])) return;

    const result = await db.query(
      "SELECT taskops_assign_task($1::uuid, $2::uuid, $3::text, $4::uuid) AS result",
      [taskId, reviewerId, actor, workspace.id]
    );
    const payload = result.rows[0]?.result;
    const response = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!response?.task || !response?.reviewer) {
      throw new Error("assignment_result_invalid");
    }
    return res.json(response);
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("reviewer_at_capacity")) {
      return res.status(409).json({ error: "Reviewer is at capacity. Choose another reviewer." });
    }
    if (message.includes("task_not_assignable")) {
      return res.status(409).json({ error: "Task is not assignable. It must be queued or need revision." });
    }
    if (message.includes("reviewer_not_found")) {
      return res.status(404).json({ error: "Active reviewer not found." });
    }
    if (message.includes("task_not_found")) {
      return res.status(404).json({ error: "Task not found." });
    }
    if (message.includes("task_and_reviewer_workspace_required")) {
      return res.status(400).json({ error: "Task and reviewer are required." });
    }
    console.error("task_assign_failed", error);
    return res.status(500).json({ error: "Unable to assign reviewer." });
  }
}