import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET"];

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    const limit=Math.max(1,Math.min(100,Number.parseInt(req.query.limit||"50",10)||50));
    const result=await db.query(`
      SELECT id,trace_id,span_id,parent_span_id,name,kind,status,attributes,
        started_at,ended_at,duration_ms,created_at
      FROM agent_traces WHERE workspace_id=$1
      ORDER BY started_at DESC NULLS LAST,created_at DESC LIMIT $2
    `,[workspace.id,limit]);
    const batches=await db.query(`
      SELECT id,source,status,span_count,stored_count,error,received_at,processed_at
      FROM trace_ingest_batches WHERE workspace_id=$1
      ORDER BY received_at DESC LIMIT 10
    `,[workspace.id]);
    return res.json({data:result.rows,batches:batches.rows});
  } catch(error) {
    console.error("traces_list_failed",error);
    return res.status(500).json({error:"Unable to load agent traces."});
  }
}