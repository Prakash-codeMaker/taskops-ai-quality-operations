import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET"];

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    const id=String(req.params.id||"");
    const [run,results]=await Promise.all([
      db.query(`SELECT id,mode,status,task_count,completed_count,failed_count,config,error,created_at,started_at,completed_at
        FROM evaluation_runs WHERE id=$1 AND workspace_id=$2 LIMIT 1`,[id,workspace.id]),
      db.query(`SELECT r.id,r.task_id,t.external_id,t.title,r.evaluator,r.model,r.score,r.verdict,
          r.dimensions,r.rationale,r.evidence,r.metadata,r.created_at
        FROM evaluation_results r
        JOIN tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id
        WHERE r.run_id=$1 AND r.workspace_id=$2
        ORDER BY r.created_at ASC`,[id,workspace.id])
    ]);
    if(!run.rows.length) return res.status(404).json({error:"Evaluation run not found."});
    return res.json({run:run.rows[0],results:results.rows});
  } catch(error) {
    console.error("evaluation_detail_failed",error);
    return res.status(500).json({error:"Unable to load evaluation details."});
  }
}