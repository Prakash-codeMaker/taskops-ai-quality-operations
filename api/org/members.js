import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET"];

export default async function(req,res) {
  try {
    const workspace = await requireWorkspace(req,res);
    if (!workspace) return;
    const [organizationResult,workspaceResult] = await Promise.all([
      db.query("SELECT taskops_list_org_members($1::text,$2::uuid) AS members",[String(req.user.id),workspace.id]),
      db.query("SELECT taskops_list_workspace_members($1::text,$2::uuid) AS members",[String(req.user.id),workspace.id])
    ]);
    const orgRaw=organizationResult.rows[0]?.members||[];
    const workspaceRaw=workspaceResult.rows[0]?.members||[];
    return res.json({
      data:typeof orgRaw==="string"?JSON.parse(orgRaw):orgRaw,
      workspace_members:typeof workspaceRaw==="string"?JSON.parse(workspaceRaw):workspaceRaw
    });
  } catch(error) {
    console.error("org_members_failed",error);
    return res.status(500).json({error:"Unable to load organization members."});
  }
}