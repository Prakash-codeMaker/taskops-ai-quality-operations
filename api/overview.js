import { db } from "hatchable";
import { requireWorkspace, workspaceSummary } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET"];

export default async function (req, res) {
  try {
    const workspace = await requireWorkspace(req, res);
    if (!workspace) return;

    const [summary, trend, queues, recent] = await Promise.all([
      db.query(`SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE status = 'in_review')::int AS in_review,
        COUNT(*) FILTER (WHERE status = 'awaiting_approval')::int AS awaiting_approval,
        COUNT(*) FILTER (WHERE status = 'needs_revision')::int AS needs_revision,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        ROUND(AVG(quality_score), 1) AS avg_quality,
        ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'approved') /
          NULLIF(COUNT(*) FILTER (WHERE status IN ('approved','rejected')), 0), 1) AS approval_rate,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS created_24h,
        COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '24 hours'
          AND status IN ('approved','rejected'))::int AS completed_24h
      FROM tasks
      WHERE workspace_id = $1`, [workspace.id]),
      db.query(`WITH day_range AS (
        SELECT day::date AS date
        FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS day
      ),
      created AS (
        SELECT created_at::date AS date, COUNT(*)::int AS created
        FROM tasks
        WHERE workspace_id = $1
          AND created_at >= CURRENT_DATE - INTERVAL '6 days'
        GROUP BY created_at::date
      ),
      completed AS (
        SELECT created_at::date AS date, COUNT(DISTINCT task_id)::int AS completed
        FROM task_events
        WHERE workspace_id = $1
          AND created_at >= CURRENT_DATE - INTERVAL '6 days'
          AND to_status IN ('approved','rejected')
        GROUP BY created_at::date
      )
      SELECT
        TO_CHAR(d.date, 'Dy') AS label,
        d.date AS date,
        COALESCE(c.created, 0)::int AS created,
        COALESCE(x.completed, 0)::int AS completed
      FROM day_range d
      LEFT JOIN created c ON c.date = d.date
      LEFT JOIN completed x ON x.date = d.date
      ORDER BY d.date`, [workspace.id]),
      db.query(`SELECT project, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('queued','in_review','needs_revision'))::int AS active
      FROM tasks
      WHERE workspace_id = $1
      GROUP BY project ORDER BY total DESC LIMIT 5`, [workspace.id]),
      db.query(`SELECT e.id, e.action, e.actor, e.from_status, e.to_status, e.created_at,
        t.external_id, t.title
      FROM task_events e
      JOIN tasks t ON t.id = e.task_id AND t.workspace_id = e.workspace_id
      WHERE e.workspace_id = $1
      ORDER BY e.created_at DESC LIMIT 8`, [workspace.id])
    ]);

    res.json({
      workspace: workspaceSummary(workspace),
      summary: summary.rows[0] || {},
      trend: trend.rows,
      queues: queues.rows,
      recent_activity: recent.rows
    });
  } catch (error) {
    console.error("overview_failed", error);
    res.status(500).json({ error: "Unable to load operational overview." });
  }
}