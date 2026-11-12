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
        SELECT id,name,task_type,version,schema_json,is_active,created_by,created_at
        FROM task_schemas
        WHERE workspace_id=$1
        ORDER BY name ASC,version DESC LIMIT 100
      `,[workspace.id]);
      return res.json({data:result.rows});
    }

    if(!requireRole(workspace,res,["owner","admin","quality_lead"])) return;
    const name=String(req.body?.name||"").trim().slice(0,80);
    const taskType=String(req.body?.task_type||"").trim().slice(0,60);
    let schema=req.body?.schema_json;
    if(typeof schema==="string") {
      try { schema=JSON.parse(schema); } catch { return res.status(400).json({error:"Schema must be valid JSON."}); }
    }
    if(name.length<2||taskType.length<2||!schema||typeof schema!=="object"||Array.isArray(schema)) {
      return res.status(400).json({error:"Provide a schema name, task type and JSON Schema object."});
    }
    if(JSON.stringify(schema).length>32000) return res.status(413).json({error:"Schema exceeds 32 KB."});
    if(schema.type && schema.type!=="object") return res.status(400).json({error:"Task payload schemas must have type 'object'."});

    const versionResult=await db.query(
      "SELECT COALESCE(MAX(version),0)::int+1 AS next_version FROM task_schemas WHERE workspace_id=$1 AND name=$2",
      [workspace.id,name]
    );
    const version=versionResult.rows[0].next_version;
    const result=await db.transaction([
      {sql:"UPDATE task_schemas SET is_active=FALSE WHERE workspace_id=$1 AND name=$2",params:[workspace.id,name]},
      {sql:`INSERT INTO task_schemas(workspace_id,name,task_type,version,schema_json,is_active,created_by)
        VALUES($1,$2,$3,$4,$5::jsonb,TRUE,$6)
        RETURNING id,name,task_type,version,schema_json,is_active,created_at`,
       params:[workspace.id,name,taskType,version,JSON.stringify(schema),String(req.user.id)]}
    ]);
    return res.status(201).json({schema:result.results[1].rows[0]});
  } catch(error) {
    console.error("task_schema_failed",error);
    return res.status(500).json({error:"Unable to manage task schemas."});
  }
}