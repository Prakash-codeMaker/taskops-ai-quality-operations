import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET"];

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    const resource=String(req.query.resource||"tasks");
    const limit=Math.max(1,Math.min(500,Number.parseInt(req.query.limit||"200",10)||200));
    let result;
    if(resource==="tasks") {
      result=await db.query(`
        SELECT id,external_id,title,description,project,queue,task_type,priority,status,payload,
          quality_score,latest_verdict,revision,review_count,created_at,updated_at
        FROM tasks WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2
      `,[workspace.id,limit]);
    } else if(resource==="evaluations") {
      result=await db.query(`
        SELECT r.id,r.run_id,r.task_id,t.external_id,t.title,r.evaluator,r.model,
          r.score,r.verdict,r.dimensions,r.rationale,r.evidence,r.metadata,r.created_at
        FROM evaluation_results r
        JOIN tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id
        WHERE r.workspace_id=$1 ORDER BY r.created_at DESC LIMIT $2
      `,[workspace.id,limit]);
    } else if(resource==="traces") {
      result=await db.query(`
        SELECT trace_id,span_id,parent_span_id,name,kind,status,attributes,
          started_at,ended_at,duration_ms,created_at
        FROM agent_traces WHERE workspace_id=$1
        ORDER BY started_at DESC NULLS LAST,created_at DESC LIMIT $2
      `,[workspace.id,limit]);
    } else {
      return res.status(400).json({error:"resource must be tasks, evaluations or traces."});
    }
    return res.json({resource,workspace_id:workspace.id,exported_at:new Date().toISOString(),count:result.rows.length,data:result.rows});
  } catch(error) {
    console.error("workspace_export_failed",error);
    return res.status(500).json({error:"Unable to export workspace data."});
  }
}