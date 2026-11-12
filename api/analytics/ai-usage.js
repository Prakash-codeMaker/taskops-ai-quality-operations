import { ai, db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET"];

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(!requireRole(workspace,res,["owner","admin","quality_lead"])) return;
    const window=["24h","7d","30d","mtd"].includes(String(req.query.window||""))
      ?String(req.query.window):"7d";
    const memberResult=await db.query(
      "SELECT taskops_workspace_member_ids($1::text,$2::uuid) AS user_ids",
      [String(req.user.id),workspace.id]
    );
    const rawIds=memberResult.rows[0]?.user_ids||[];
    const ids=typeof rawIds==="string"?JSON.parse(rawIds):rawIds;
    const usage=await ai.usage({window});
    const rows=(usage.by_user_id||[]).filter(row=>ids.includes(String(row.user_id)));
    const calls=rows.reduce((n,row)=>n+Number(row.calls||0),0);
    const spend=rows.reduce((n,row)=>n+Number(row.cost_usd||0),0);
    const unpriced=rows.reduce((n,row)=>n+Number(row.unpriced_calls||0),0);
    return res.json({
      window,
      scope:"active_workspace_members",
      totals:{calls,cost_usd:Math.round(spend*10000)/10000,unpriced_calls:unpriced,cost_is_complete:unpriced===0},
      members:rows.map(row=>({calls:Number(row.calls||0),cost_usd:Number(row.cost_usd||0)}))
    });
  } catch(error) {
    const message=String(error?.message||"");
    if(error?.code==="SetupRequired"||message.includes("SetupRequired")||(message.includes("provider")&&message.includes("configured"))) {
      return res.status(424).json({error:"Connect an AI provider in the TaskOps project Setup page to view AI spend and run AI judging."});
    }
    console.error("ai_usage_failed",error);
    return res.status(500).json({error:"Unable to load workspace AI usage."});
  }
}