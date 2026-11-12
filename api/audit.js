import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET"];

export default async function (req, res) {
  try {
    const workspace = await requireWorkspace(req, res);
    if (!workspace) return;
    const limit = Math.max(10, Math.min(100, Number.parseInt(req.query.limit || "30", 10) || 30));
    const result = await db.query(`
      SELECT e.id,e.actor,e.action,e.from_status,e.to_status,e.metadata,e.created_at,
        t.id AS task_id,t.external_id,t.title
      FROM task_events e JOIN tasks t ON t.id=e.task_id AND t.workspace_id=e.workspace_id
      WHERE e.workspace_id=$1
      ORDER BY e.created_at DESC LIMIT $2
    `, [workspace.id, limit]);
    res.json({ data: result.rows });
  } catch (error) {
    console.error("audit_failed", error);
    res.status(500).json({ error: "Unable to load audit history." });
  }
}