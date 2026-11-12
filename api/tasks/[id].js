import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET"];

export default async function (req, res) {
  const id = String(req.params.id || "");
  try {
    const workspace = await requireWorkspace(req, res);
    if (!workspace) return;

    const [task, reviews, events, rubric] = await Promise.all([
      db.query(`SELECT
          t.id, t.external_id, t.title, t.description, t.project, t.queue,
          t.task_type, t.priority, t.status, t.payload, t.assigned_to,
          t.created_by, t.quality_score, t.latest_verdict, t.revision,
          t.review_count, t.due_at, t.created_at, t.updated_at,
          r.name AS reviewer_name, r.specialty AS reviewer_specialty
        FROM tasks t LEFT JOIN reviewers r ON r.id = t.assigned_to AND r.workspace_id = t.workspace_id
        WHERE t.id = $1 AND t.workspace_id = $2 LIMIT 1`, [id, workspace.id]),
      db.query(`SELECT rv.*, COALESCE(r.name,rv.submitted_by_email,'Workspace reviewer') AS reviewer_name
        FROM reviews rv LEFT JOIN reviewers r ON r.id = rv.reviewer_id AND r.workspace_id = rv.workspace_id
        WHERE rv.task_id = $1 AND rv.workspace_id = $2 ORDER BY rv.attempt_number DESC`, [id, workspace.id]),
      db.query(`SELECT id, actor, action, from_status, to_status, metadata, created_at
        FROM task_events WHERE task_id = $1 AND workspace_id = $2 ORDER BY created_at DESC LIMIT 30`, [id, workspace.id]),
      db.query(`SELECT id,name,version,dimensions,pass_threshold,critical_floor
        FROM rubric_versions WHERE workspace_id=$1 AND is_active=TRUE
        ORDER BY created_at DESC,version DESC LIMIT 1`, [workspace.id])
    ]);
    if (!task.rows.length) return res.status(404).json({ error: "Task not found." });
    res.json({ task: task.rows[0], reviews: reviews.rows, events: events.rows, rubric: rubric.rows[0] || null });
  } catch (error) {
    console.error("task_detail_failed", error);
    res.status(500).json({ error: "Unable to load task details." });
  }
}