import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET","POST"];

async function hashToken(value) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(!requireRole(workspace,res,["owner","admin","quality_lead"])) return;

    if(req.method==="GET") {
      const result=await db.query(`
        SELECT id,name,token_prefix,scopes,is_active,last_used_at,created_at
        FROM integration_tokens WHERE workspace_id=$1
        ORDER BY created_at DESC LIMIT 50
      `,[workspace.id]);
      return res.json({data:result.rows});
    }

    const name=String(req.body?.name||"").trim().slice(0,80);
    if(name.length<2) return res.status(400).json({error:"Give this integration key a name."});
    const token="taskops_live_"+crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-","");
    const tokenHash=await hashToken(token);
    const result=await db.query(`
      INSERT INTO integration_tokens(workspace_id,name,token_hash,token_prefix,created_by)
      VALUES($1,$2,$3,$4,$5)
      RETURNING id,name,token_prefix,scopes,is_active,created_at
    `,[workspace.id,name,tokenHash,token.slice(0,22),String(req.user.id)]);
    return res.status(201).json({
      integration:result.rows[0],
      token,
      ingest_url:"https://taskops-ai-data.hatchable.site/api/ingest/traces",
      warning:"Copy this token now. It is shown only once."
    });
  } catch(error) {
    console.error("integration_key_failed",error);
    return res.status(500).json({error:"Unable to manage integration keys."});
  }
}