import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["POST"];

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);

export default async function (req, res) {
  const body = req.body || {};
  const title = clean(body.title, 180);
  const description = clean(body.description, 2000);
  const project = clean(body.project || "General", 80);
  const queue = clean(body.queue || "General QA", 80);
  const taskType = clean(body.task_type || "classification", 60);
  const externalId = clean(body.external_id, 64) || null;
  const priority = Number(body.priority || 3);
  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};

  if (title.length < 3) return res.status(400).json({ error: "Title must contain at least 3 characters." });
  if (![1,2,3,4,5].includes(priority)) return res.status(400).json({ error: "Priority must be between 1 and 5." });
  if (JSON.stringify(payload).length > 12000) return res.status(413).json({ error: "Task payload exceeds the 12 KB demo limit." });

  try {
    const workspace = await requireWorkspace(req, res);
    if (!workspace) return;
    if (!requireRole(workspace, res, ["owner","admin","member","quality_lead"])) return;
    const actor = req.user?.email || "authenticated-user";
    const result = await db.query(`
      WITH created AS (
        INSERT INTO tasks (workspace_id, external_id, title, description, project, queue, task_type, priority, payload, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
        RETURNING *
      ), logged AS (
        INSERT INTO task_events (workspace_id, task_id, actor, action, from_status, to_status, metadata)
        SELECT workspace_id, id, $10, 'task_created', NULL, status, jsonb_build_object('source','manual')
        FROM created RETURNING task_id
      )
      SELECT created.* FROM created JOIN logged ON logged.task_id = created.id
    `, [workspace.id, externalId, title, description, project, queue, taskType, priority, JSON.stringify(payload), actor]);
    res.status(201).json({ task: result.rows[0] });
  } catch (error) {
    if (String(error.message || "").toLowerCase().includes("unique")) {
      return res.status(409).json({ error: "That external task ID already exists." });
    }
    console.error("task_create_failed", error);
    res.status(500).json({ error: "Unable to create task." });
  }
}