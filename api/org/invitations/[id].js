import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["DELETE"];

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(!["owner","admin"].includes(workspace.organization_role)) return res.status(403).json({error:"Organization admin role required."});
    const result=await db.query(`
      UPDATE organization_invitations SET revoked_at=NOW()
      WHERE id=$1::uuid AND organization_id=$2::uuid AND workspace_id=$3::uuid
        AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id
    `,[String(req.params.id||""),workspace.organization_id,workspace.id]);
    if(!result.rows.length) return res.status(404).json({error:"Pending invitation not found."});
    return res.json({revoked:true,id:result.rows[0].id});
  } catch(error) {
    console.error("invitation_revoke_failed",error);
    return res.status(500).json({error:"Unable to revoke invitation."});
  }
}