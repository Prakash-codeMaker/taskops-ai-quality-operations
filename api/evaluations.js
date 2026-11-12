import { db, scheduler } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET","POST"];

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;

    if(req.method==="GET") {
      const limit=Math.max(1,Math.min(50,Number.parseInt(req.query.limit||"20",10)||20));
      const result=await db.query(`
        SELECT id,mode,status,task_count,completed_count,failed_count,config,error,created_at,started_at,completed_at
        FROM evaluation_runs WHERE workspace_id=$1
        ORDER BY created_at DESC LIMIT $2
      `,[workspace.id,limit]);
      return res.json({data:result.rows});
    }

    if(!requireRole(workspace,res,["owner","admin","quality_lead","reviewer"])) return;
    const taskIds=Array.isArray(req.body?.task_ids)?Array.from(new Set(req.body.task_ids.map(String))):[];
    const mode=String(req.body?.mode||"deterministic");
    if(!["deterministic","ai","hybrid"].includes(mode)) return res.status(400).json({error:"Mode must be deterministic, ai or hybrid."});
    if(!taskIds.length||taskIds.length>20) return res.status(400).json({error:"Select between 1 and 20 task IDs."});
    if(taskIds.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) return res.status(400).json({error:"One or more task IDs are invalid."});

    const found=await db.query(
      "SELECT id FROM tasks WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
      [workspace.id,taskIds]
    );
    if(found.rows.length!==taskIds.length) return res.status(404).json({error:"One or more tasks were not found in this workspace."});

    // Snapshot the quality contract at run creation so a later rubric/schema edit
    // cannot silently change the meaning of an already queued evaluation.
    const taskTypesResult=await db.query(
      "SELECT DISTINCT task_type FROM tasks WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
      [workspace.id,taskIds]
    );
    const taskTypes=taskTypesResult.rows.map(row=>String(row.task_type));
    const [rubricResult,schemaResult,goldResult]=await Promise.all([
      db.query(`SELECT id,name,version,dimensions,pass_threshold,critical_floor
        FROM rubric_versions WHERE workspace_id=$1 AND is_active=TRUE
        ORDER BY created_at DESC,version DESC LIMIT 1`,[workspace.id]),
      db.query(`SELECT DISTINCT ON (task_type) id,name,task_type,version,schema_json
        FROM task_schemas
        WHERE workspace_id=$1 AND task_type=ANY($2::text[]) AND is_active=TRUE
        ORDER BY task_type,version DESC`,[workspace.id,taskTypes]),
      db.query(`SELECT id,task_type,input_payload,expected_output,notes,tags
        FROM gold_examples
        WHERE workspace_id=$1 AND task_type=ANY($2::text[]) AND is_active=TRUE
        ORDER BY created_at DESC LIMIT 20`,[workspace.id,taskTypes])
    ]);
    const schemaSnapshots={};
    for(const schema of schemaResult.rows) schemaSnapshots[schema.task_type]=schema;
    const goldSnapshots={};
    for(const example of goldResult.rows) {
      goldSnapshots[example.task_type] ||= [];
      if(goldSnapshots[example.task_type].length<5) goldSnapshots[example.task_type].push(example);
    }
    const configSnapshot={
      task_ids:taskIds,
      rubric_snapshot:rubricResult.rows[0]||null,
      schema_snapshots:schemaSnapshots,
      gold_snapshots:goldSnapshots
    };
    const created=await db.query(`
      INSERT INTO evaluation_runs(workspace_id,requested_by,mode,status,task_count,config)
      VALUES($1,$2,$3,'queued',$4,$5::jsonb)
      RETURNING id,status,mode,task_count,created_at
    `,[workspace.id,String(req.user.id),mode,taskIds.length,JSON.stringify(configSnapshot)]);
    const run=created.rows[0];

    try {
      await scheduler.now("/api/jobs/run-evaluation",{run_id:run.id});
    } catch(error) {
      await db.query("UPDATE evaluation_runs SET status='failed',error=$1,completed_at=NOW() WHERE id=$2 AND workspace_id=$3",
        [String(error?.message||"Scheduler unavailable").slice(0,500),run.id,workspace.id]);
      return res.status(503).json({error:"Evaluation was created but the worker could not be scheduled. Try again.",run_id:run.id});
    }
    return res.status(202).json({run});
  } catch(error) {
    console.error("evaluation_request_failed",error);
    return res.status(500).json({error:"Unable to start evaluation."});
  }
}