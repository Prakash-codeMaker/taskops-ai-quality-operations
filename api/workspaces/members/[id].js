import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["DELETE"];

export default async function(req,res) {
  const membershipId=String(req.params.id||"");
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(!requireRole(workspace,res,["owner","admin"])) return;
    const result=await db.query(
      "SELECT taskops_remove_workspace_member($1::text,$2::uuid) AS result",
      [String(req.user.id),membershipId]
    );
    return res.json({result:result.rows[0]?.result||{removed:true}});
  } catch(error) {
    const message=String(error?.message||"");
    if(message.includes("workspace_owner_role_required")) return res.status(403).json({error:"Only a workspace owner can remove a workspace owner or admin."});
    if(message.includes("cannot_remove_last_workspace_owner")) return res.status(409).json({error:"A workspace must retain at least one active owner."});
    if(message.includes("workspace_member_not_found")) return res.status(404).json({error:"Workspace member not found."});
    if(message.includes("workspace_admin_required")) return res.status(403).json({error:"Workspace owner/admin role required."});
    if(message.includes("reviewer_has_open_tasks")) return res.status(409).json({error:"Reassign this member's open review tasks before removing workspace access."});
    console.error("workspace_member_remove_failed",error);
    return res.status(500).json({error:"Unable to remove workspace membership."});
  }
}