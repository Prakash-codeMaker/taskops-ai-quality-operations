import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["POST"];

export default async function(req,res) {
  const memberId = String(req.params.id || "");
  const role = String(req.body?.role || "");
  try {
    const workspace = await requireWorkspace(req,res);
    if (!workspace) return;
    if (!["owner","admin"].includes(workspace.organization_role)) return res.status(403).json({error:"Organization admin role required."});
    const result = await db.query(
      "SELECT taskops_change_member_role($1::text,$2::uuid,$3::text) AS result",
      [String(req.user.id),memberId,role]
    );
    return res.json({result:result.rows[0]?.result || {ok:true}});
  } catch(error) {
    const message=String(error?.message||"");
    if(message.includes("owner_role_required")) return res.status(403).json({error:"Only an organization owner can change owner/admin roles."});
    if(message.includes("cannot_remove_last_owner")) return res.status(409).json({error:"An organization must retain at least one active owner."});
    if(message.includes("member_not_found")) return res.status(404).json({error:"Member not found."});
    if(message.includes("invalid_organization_role")) return res.status(400).json({error:"Organization roles are owner, admin or member."});
    console.error("member_role_update_failed",error);
    return res.status(500).json({error:"Unable to change member role."});
  }
}