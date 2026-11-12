import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["POST"];

const transitions = {
  queued: ["rejected"],
  in_review: ["needs_revision","rejected"],
  awaiting_approval: ["approved","needs_revision","rejected"],
  needs_revision: ["queued","rejected"],
  approved: [],
  rejected: []
};

export default async function (req, res) {
  const taskId = String(req.params.id || "");
  const nextStatus = String(req.body?.status || "");
  const note = String(req.body?.note || "").trim().slice(0, 1000);
  const actor = req.user?.email || "authenticated-user";
  try {
    const workspace = await requireWorkspace(req, res);
    if (!workspace) return;
    if (!requireRole(workspace, res, ["owner","admin","quality_lead"])) return;
    const current = await db.query(`SELECT id,status,external_id,title FROM tasks WHERE id=$1 AND workspace_id=$2 LIMIT 1`, [taskId, workspace.id]);
    if (!current.rows.length) return res.status(404).json({ error: "Task not found." });
    const previous = current.rows[0].status;
    if (!(transitions[previous] || []).includes(nextStatus)) {
      return res.status(409).json({ error: `Transition from ${previous} to ${nextStatus} is not allowed.`, allowed: transitions[previous] || [] });
    }

    const result = await db.query(`
      WITH changed AS (
        UPDATE tasks SET
          status=$2,
          assigned_to=CASE WHEN $2='queued' AND status='needs_revision' THEN NULL ELSE assigned_to END,
          revision=CASE WHEN $2='queued' AND status='needs_revision' THEN revision+1 ELSE revision END,
          updated_at=NOW()
        WHERE id=$1 AND status=$3 AND workspace_id=$6
        RETURNING id,workspace_id,external_id,title,status,revision
      ), logged AS (
        INSERT INTO task_events (workspace_id,task_id,actor,action,from_status,to_status,metadata)
        SELECT workspace_id,id,$4,'status_transition',$3,status,jsonb_build_object('note',$5::text)
        FROM changed RETURNING task_id
      )
      SELECT changed.* FROM changed JOIN logged ON logged.task_id=changed.id
    `, [taskId, nextStatus, previous, actor, note, workspace.id]);
    if (!result.rows.length) return res.status(409).json({ error: "Task changed concurrently. Refresh and retry." });
    res.json({ task: result.rows[0] });
  } catch (error) {
    console.error("task_transition_failed", error);
    res.status(500).json({ error: "Unable to update task status." });
  }
}