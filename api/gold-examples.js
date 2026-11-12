import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET","POST"];

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(req.method==="GET") {
      const result=await db.query(`
        SELECT id,task_type,input_payload,expected_output,notes,tags,is_active,created_at
        FROM gold_examples WHERE workspace_id=$1
        ORDER BY created_at DESC LIMIT 100
      `,[workspace.id]);
      return res.json({data:result.rows});
    }
    if(!requireRole(workspace,res,["owner","admin","quality_lead","reviewer"])) return;
    const taskType=String(req.body?.task_type||"").trim().slice(0,60);
    const input=req.body?.input_payload;
    const expected=req.body?.expected_output;
    const notes=String(req.body?.notes||"").trim().slice(0,2000);
    const tags=Array.isArray(req.body?.tags)?req.body.tags.slice(0,20).map(x=>String(x).slice(0,40)):[];
    if(taskType.length<2||!input||typeof input!=="object"||!expected||typeof expected!=="object") {
      return res.status(400).json({error:"Provide task_type, input_payload and expected_output JSON objects."});
    }
    if(JSON.stringify(input).length>16000||JSON.stringify(expected).length>16000) return res.status(413).json({error:"Gold example fields are limited to 16 KB each."});
    const result=await db.query(`
      INSERT INTO gold_examples(workspace_id,task_type,input_payload,expected_output,notes,tags,created_by)
      VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7)
      RETURNING id,task_type,input_payload,expected_output,notes,tags,is_active,created_at
    `,[workspace.id,taskType,JSON.stringify(input),JSON.stringify(expected),notes,JSON.stringify(tags),String(req.user.id)]);
    return res.status(201).json({example:result.rows[0]});
  } catch(error) {
    console.error("gold_example_failed",error);
    return res.status(500).json({error:"Unable to manage gold examples."});
  }
}