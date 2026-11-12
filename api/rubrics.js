import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET","POST"];

const DEFAULT_DIMENSIONS={
  correctness:0.30,
  completeness:0.20,
  instruction_adherence:0.20,
  format_validity:0.15,
  evidence_quality:0.15
};

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;

    if(req.method==="GET") {
      const result=await db.query(`
        SELECT id,name,version,dimensions,pass_threshold,critical_floor,is_active,created_at
        FROM rubric_versions WHERE workspace_id=$1
        ORDER BY name ASC,version DESC LIMIT 100
      `,[workspace.id]);
      return res.json({data:result.rows});
    }

    if(!requireRole(workspace,res,["owner","admin","quality_lead"])) return;
    const name=String(req.body?.name||"").trim().slice(0,80);
    const dimensions=req.body?.dimensions||DEFAULT_DIMENSIONS;
    const keys=["correctness","completeness","instruction_adherence","format_validity","evidence_quality"];
    if(name.length<2||!dimensions||typeof dimensions!=="object") return res.status(400).json({error:"Rubric name and dimension weights are required."});
    if(Object.keys(dimensions).some(key=>!keys.includes(key))) return res.status(400).json({error:"Rubric contains an unsupported scoring dimension."});
    const values=keys.map(k=>Number(dimensions[k]));
    if(values.some(v=>!Number.isFinite(v)||v<0||v>1)) return res.status(400).json({error:"Each rubric weight must be between 0 and 1, and all five dimensions are required."});
    const total=values.reduce((a,b)=>a+b,0);
    if(Math.abs(total-1)>0.001) return res.status(400).json({error:"Rubric weights must sum to 1.0."});
    const threshold=Number(req.body?.pass_threshold??85);
    const floor=Number(req.body?.critical_floor??2);
    if(!Number.isFinite(threshold)||!Number.isFinite(floor)||threshold<0||threshold>100||floor<1||floor>5) return res.status(400).json({error:"Pass threshold must be 0–100 and critical floor must be 1–5."});

    const v=await db.query("SELECT COALESCE(MAX(version),0)::int+1 AS next_version FROM rubric_versions WHERE workspace_id=$1 AND name=$2",[workspace.id,name]);
    const version=v.rows[0].next_version;
    const result=await db.transaction([
      {sql:"UPDATE rubric_versions SET is_active=FALSE WHERE workspace_id=$1 AND name=$2",params:[workspace.id,name]},
      {sql:`INSERT INTO rubric_versions(workspace_id,name,version,dimensions,pass_threshold,critical_floor,is_active,created_by)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,TRUE,$7)
        RETURNING id,name,version,dimensions,pass_threshold,critical_floor,is_active,created_at`,
       params:[workspace.id,name,version,JSON.stringify(dimensions),threshold,floor,String(req.user.id)]}
    ]);
    return res.status(201).json({rubric:result.results[1].rows[0]});
  } catch(error) {
    console.error("rubric_failed",error);
    return res.status(500).json({error:"Unable to manage rubric versions."});
  }
}