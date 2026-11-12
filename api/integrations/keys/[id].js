import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["DELETE"];

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(!requireRole(workspace,res,["owner","admin","quality_lead"])) return;
    const result=await db.query(`
      UPDATE integration_tokens SET is_active=FALSE
      WHERE id=$1::uuid AND workspace_id=$2::uuid AND is_active=TRUE
      RETURNING id
    `,[String(req.params.id||""),workspace.id]);
    if(!result.rows.length) return res.status(404).json({error:"Active integration key not found."});
    return res.json({revoked:true,id:result.rows[0].id});
  } catch(error) {
    console.error("integration_key_revoke_failed",error);
    return res.status(500).json({error:"Unable to revoke integration key."});
  }
}