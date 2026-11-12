import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["PUT","DELETE"];

export default async function(req,res) {
  const reviewerId=String(req.params.id||"");
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(!requireRole(workspace,res,["owner","admin","quality_lead"])) return;

    if(req.method==="DELETE") {
      const workload=await db.query(`
        SELECT COUNT(*)::int AS open_tasks FROM tasks
        WHERE workspace_id=$1 AND assigned_to=$2::uuid
          AND status IN ('in_review','needs_revision','awaiting_approval')
      `,[workspace.id,reviewerId]);
      if(Number(workload.rows[0]?.open_tasks||0)>0) {
        return res.status(409).json({error:"Reassign this reviewer's open tasks before deactivating the profile."});
      }
      const result=await db.query(`
        UPDATE reviewers SET active=FALSE
        WHERE id=$1::uuid AND workspace_id=$2::uuid AND active=TRUE
        RETURNING id,name,active
      `,[reviewerId,workspace.id]);
      if(!result.rows.length) return res.status(404).json({error:"Active reviewer not found."});
      return res.json({reviewer:result.rows[0]});
    }

    const capacity=req.body?.capacity===undefined?null:Number(req.body.capacity);
    const specialty=req.body?.specialty===undefined?null:String(req.body.specialty).trim().slice(0,120);
    const active=req.body?.active===undefined?null:Boolean(req.body.active);
    if(capacity!==null&&(!Number.isInteger(capacity)||capacity<1||capacity>100)) return res.status(400).json({error:"Capacity must be an integer from 1 to 100."});
    if(active===false) {
      const workload=await db.query(`
        SELECT COUNT(*)::int AS open_tasks FROM tasks
        WHERE workspace_id=$1 AND assigned_to=$2::uuid
          AND status IN ('in_review','needs_revision','awaiting_approval')
      `,[workspace.id,reviewerId]);
      if(Number(workload.rows[0]?.open_tasks||0)>0) return res.status(409).json({error:"Reassign this reviewer's open tasks before deactivating the profile."});
    }
    const result=await db.query(`
      UPDATE reviewers SET
        capacity=COALESCE($3,capacity),
        specialty=COALESCE($4,specialty),
        active=COALESCE($5,active)
      WHERE id=$1::uuid AND workspace_id=$2::uuid
      RETURNING id,name,email,role,specialty,capacity,active
    `,[reviewerId,workspace.id,capacity,specialty,active]);
    if(!result.rows.length) return res.status(404).json({error:"Reviewer not found in this workspace."});
    return res.json({reviewer:result.rows[0]});
  } catch(error) {
    console.error("reviewer_update_failed",error);
    return res.status(500).json({error:"Unable to update reviewer."});
  }
}