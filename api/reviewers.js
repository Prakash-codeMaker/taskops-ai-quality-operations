import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET","POST"];

const clean=(value,max=500)=>String(value??"").trim().slice(0,max);
const validEmail=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;

    if(req.method==="GET") {
      const result=await db.query(`
        SELECT r.id,r.name,r.email,r.role,r.specialty,r.capacity,r.active,
          (r.user_id IS NOT NULL) AS linked_account,
          (SELECT COUNT(*)::int FROM tasks t
            WHERE t.workspace_id=$1 AND t.assigned_to=r.id
              AND t.status IN ('in_review','needs_revision','awaiting_approval')) AS open_tasks,
          (SELECT ROUND(AVG(rv.overall_score),1) FROM reviews rv
            WHERE rv.workspace_id=$1 AND rv.reviewer_id=r.id) AS avg_score
        FROM reviewers r
        WHERE r.workspace_id=$1
        ORDER BY r.active DESC,r.name ASC
      `,[workspace.id]);
      return res.json({data:result.rows});
    }

    if(!requireRole(workspace,res,["owner","admin","quality_lead"])) return;
    const userId=clean(req.body?.user_id,160);
    if(!userId) return res.status(400).json({error:"Choose a workspace member with the Reviewer or Quality Lead role."});

    const member=await db.query(`
      SELECT wm.user_id,wm.role AS workspace_role,
        om.email,COALESCE(NULLIF(u.name,''),SPLIT_PART(om.email,'@',1)) AS display_name
      FROM workspace_memberships wm
      JOIN workspaces w ON w.id=wm.workspace_id
      JOIN organization_memberships om
        ON om.organization_id=w.organization_id AND om.user_id=wm.user_id AND om.active=TRUE
      LEFT JOIN users u ON u.hatchable_user_id=wm.user_id
      WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND wm.active=TRUE
      LIMIT 1
    `,[workspace.id,userId]);
    if(!member.rows.length) return res.status(404).json({error:"Active workspace member not found."});
    const source=member.rows[0];
    if(!["reviewer","quality_lead"].includes(source.workspace_role)) {
      return res.status(409).json({error:"Set this member's workspace role to Reviewer or Quality Lead first."});
    }
    const email=clean(source.email,254).toLowerCase();
    const name=clean(source.display_name||email.split("@")[0],120);
    if(!validEmail(email)) return res.status(409).json({error:"The member's verified email is not available. Ask them to sign in again."});
    const specialty=clean(req.body?.specialty||"General quality review",120);
    const capacity=Number(req.body?.capacity??8);
    if(!Number.isInteger(capacity)||capacity<1||capacity>100) return res.status(400).json({error:"Capacity must be an integer from 1 to 100."});

    const result=await db.query(`
      INSERT INTO reviewers(workspace_id,user_id,name,email,role,specialty,capacity,active)
      VALUES($1,$2,$3,$4,$5,$6,$7,TRUE)
      ON CONFLICT(workspace_id,user_id) WHERE user_id IS NOT NULL
      DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,role=EXCLUDED.role,
        specialty=EXCLUDED.specialty,capacity=EXCLUDED.capacity,active=TRUE
      RETURNING id,name,email,role,specialty,capacity,active,created_at
    `,[
      workspace.id,userId,name,email,
      source.workspace_role==="quality_lead"?"Quality Lead":"Reviewer",
      specialty,capacity
    ]);
    return res.status(201).json({reviewer:result.rows[0]});
  } catch(error) {
    const message=String(error?.message||"");
    if(message.toLowerCase().includes("unique")) return res.status(409).json({error:"This workspace member already has a reviewer profile."});
    console.error("reviewers_failed",error);
    return res.status(500).json({error:"Unable to manage reviewers."});
  }
}