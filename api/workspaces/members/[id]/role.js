import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["POST"];

export default async function(req,res) {
  const membershipId=String(req.params.id||"");
  const role=String(req.body?.role||"");
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(!requireRole(workspace,res,["owner","admin"])) return;
    const result=await db.query(
      "SELECT taskops_change_workspace_member_role($1::text,$2::uuid,$3::text) AS result",
      [String(req.user.id),membershipId,role]
    );
    return res.json({result:result.rows[0]?.result||{ok:true}});
  } catch(error) {
    const message=String(error?.message||"");
    if(message.includes("workspace_owner_role_required")) return res.status(403).json({error:"Only a workspace owner can change owner/admin roles."});
    if(message.includes("cannot_remove_last_workspace_owner")) return res.status(409).json({error:"A workspace must retain at least one active owner."});
    if(message.includes("workspace_member_not_found")) return res.status(404).json({error:"Workspace member not found."});
    if(message.includes("invalid_workspace_role")) return res.status(400).json({error:"Invalid workspace role."});
    if(message.includes("workspace_admin_required")) return res.status(403).json({error:"Workspace owner/admin role required."});
    if(message.includes("reviewer_has_open_tasks")) return res.status(409).json({error:"Reassign this reviewer's open tasks before changing their role."});
    console.error("workspace_member_role_failed",error);
    return res.status(500).json({error:"Unable to change workspace member role."});
  }
}