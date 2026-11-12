import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["DELETE"];

export default async function(req,res) {
  const memberId=String(req.params.id||"");
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(!["owner","admin"].includes(workspace.organization_role)) return res.status(403).json({error:"Organization admin role required."});
    const result=await db.query(
      "SELECT taskops_remove_org_member($1::text,$2::uuid) AS result",
      [String(req.user.id),memberId]
    );
    return res.json({result:result.rows[0]?.result||{removed:true}});
  } catch(error) {
    const message=String(error?.message||"");
    if(message.includes("owner_role_required")) return res.status(403).json({error:"Only an organization owner can remove an owner or admin."});
    if(message.includes("cannot_remove_last_owner")) return res.status(409).json({error:"An organization must retain at least one active owner."});
    if(message.includes("member_not_found")) return res.status(404).json({error:"Member not found."});
    if(message.includes("reviewer_has_open_tasks")) return res.status(409).json({error:"Reassign this member's open review tasks in every workspace before removing organization access."});
    console.error("member_remove_failed",error);
    return res.status(500).json({error:"Unable to remove organization member."});
  }
}