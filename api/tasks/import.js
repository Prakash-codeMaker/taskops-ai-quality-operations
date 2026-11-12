import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["POST"];

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);

export default async function (req, res) {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  const source = clean(req.body?.source || "manual-import", 120);
  if (!records.length) return res.status(400).json({ error: "Provide a non-empty records array." });
  if (records.length > 100) return res.status(413).json({ error: "Import is limited to 100 rows per batch." });

  let workspace;
  try {
    workspace = await requireWorkspace(req, res);
  } catch (error) {
    console.error("import_workspace_resolution_failed", error);
    return res.status(500).json({ error: "Unable to resolve the active workspace." });
  }
  if (!workspace) return;
  if (!requireRole(workspace, res, ["owner","admin","member","quality_lead"])) return;
  const actor = req.user?.email || "authenticated-user";
  let inserted = 0, duplicates = 0, rejected = 0;
  const errors = [];

  for (let index = 0; index < records.length; index++) {
    const row = records[index] && typeof records[index] === "object" ? records[index] : {};
    const title = clean(row.title, 180);
    const priority = Number(row.priority || 3);
    if (title.length < 3 || ![1,2,3,4,5].includes(priority)) {
      rejected++;
      errors.push({ row: index + 1, reason: title.length < 3 ? "Title must have at least 3 characters." : "Priority must be 1–5." });
      continue;
    }

    const externalId = clean(row.external_id, 64) || `IMP-${Date.now()}-${index + 1}`;
    const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
    if (JSON.stringify(payload).length > 12000) {
      rejected++;
      errors.push({ row: index + 1, reason: "Payload exceeds 12 KB." });
      continue;
    }
    try {
      const result = await db.query(`
        WITH created AS (
          INSERT INTO tasks (workspace_id,external_id,title,description,project,queue,task_type,priority,payload,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
          ON CONFLICT (workspace_id,external_id) DO NOTHING
          RETURNING id, workspace_id, external_id, title, status
        ), logged AS (
          INSERT INTO task_events (workspace_id,task_id,actor,action,to_status,metadata)
          SELECT workspace_id,id,$10,'task_imported',status,jsonb_build_object('source',$11::text,'row',$12::integer)
          FROM created RETURNING task_id
        )
        SELECT created.id FROM created JOIN logged ON logged.task_id=created.id
      `, [
        workspace.id, externalId, title, clean(row.description, 2000), clean(row.project || "Imported", 80),
        clean(row.queue || "General QA", 80), clean(row.task_type || "classification", 60),
        priority, JSON.stringify(payload), actor, source, index + 1
      ]);
      if (result.rows.length) inserted++; else duplicates++;
    } catch (error) {
      rejected++;
      errors.push({ row: index + 1, reason: "Row could not be stored; check the ID and field values." });
    }
  }

  try {
    await db.query(`INSERT INTO import_batches (workspace_id,source_name,submitted_count,inserted_count,duplicate_count,rejected_count,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [workspace.id, source, records.length, inserted, duplicates, rejected, actor]);
  } catch (error) {
    console.error("import_batch_log_failed", error);
  }
  res.json({ submitted: records.length, inserted, duplicates, rejected, errors });
}