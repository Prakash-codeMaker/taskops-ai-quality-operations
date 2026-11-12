import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET"];

export default async function (req, res) {
  try {
    const workspace = await requireWorkspace(req, res);
    if (!workspace) return;

    const status = String(req.query.status || "").trim();
    const search = String(req.query.q || "").trim().slice(0, 100);
    const project = String(req.query.project || "").trim().slice(0, 80);
    const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page || "1", 10) || 1));
    const limit = Math.max(5, Math.min(50, Number.parseInt(req.query.limit || "12", 10) || 12));
    const offset = (page - 1) * limit;

    const where = `WHERE t.workspace_id = $1
      AND ($2 = '' OR t.status = $2)
      AND ($3 = '' OR t.title ILIKE '%' || $3 || '%' OR COALESCE(t.external_id,'') ILIKE '%' || $3 || '%')
      AND ($4 = '' OR t.project = $4)`;

    const [rows, count] = await Promise.all([
      db.query(`SELECT t.id, t.external_id, t.title, t.description, t.project, t.queue,
        t.task_type, t.priority, t.status, t.quality_score, t.latest_verdict,
        t.revision, t.review_count, t.due_at, t.created_at, t.updated_at,
        r.name AS reviewer_name, r.specialty AS reviewer_specialty
        FROM tasks t LEFT JOIN reviewers r ON r.id = t.assigned_to AND r.workspace_id = t.workspace_id
        ${where}
        ORDER BY t.priority DESC, t.due_at ASC NULLS LAST, t.updated_at DESC
        LIMIT $5 OFFSET $6`, [workspace.id, status, search, project, limit, offset]),
      db.query(`SELECT COUNT(*)::int AS total FROM tasks t ${where}`, [workspace.id, status, search, project])
    ]);

    const total = Number(count.rows[0]?.total || 0);
    res.json({ data: rows.rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error("tasks_list_failed", error);
    res.status(500).json({ error: "Unable to load tasks." });
  }
}