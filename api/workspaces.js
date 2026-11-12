import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET","POST"];

const slugify = value => String(value || "").toLowerCase().trim()
  .replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,48);

export default async function(req,res) {
  const userId = String(req.user?.id || "");
  if (!userId) return res.status(401).json({error:"Sign in required."});

  try {
    if (req.method === "GET") {
      const result = await db.query(
        "SELECT taskops_list_user_workspaces($1::text) AS workspaces",
        [userId]
      );
      const raw = result.rows[0]?.workspaces || [];
      const workspaces = typeof raw === "string" ? JSON.parse(raw) : raw;
      return res.json({data:workspaces});
    }

    const current = await requireWorkspace(req,res);
    if (!current) return;
    if (!["owner","admin"].includes(current.organization_role)) {
      return res.status(403).json({error:"Only organization owners and admins can create workspaces."});
    }
    const name = String(req.body?.name || "").trim().slice(0,120);
    const slug = slugify(req.body?.slug || name);
    if (name.length < 2 || slug.length < 2) {
      return res.status(400).json({error:"Workspace name and slug must contain at least 2 characters."});
    }
    const result = await db.transaction([
      {sql:`INSERT INTO workspaces(organization_id,name,slug)
        VALUES($1::uuid,$2,$3) RETURNING id,name,slug,organization_id`,
       params:[current.organization_id,name,slug]},
      {sql:`INSERT INTO workspace_memberships(workspace_id,user_id,role,active)
        SELECT id,$1,$2,TRUE FROM workspaces
        WHERE organization_id=$3::uuid AND slug=$4
        ON CONFLICT(workspace_id,user_id) DO NOTHING`,
       params:[userId,current.organization_role,current.organization_id,slug]}
    ]);
    const workspace = result.results[0]?.rows?.[0];
    if (!workspace) return res.status(409).json({error:"Workspace could not be created."});
    return res.status(201).json({workspace});
  } catch(error) {
    if(String(error?.message||"").toLowerCase().includes("unique")) return res.status(409).json({error:"That workspace slug already exists in this organization."});
    console.error("workspaces_failed",error);
    return res.status(500).json({error:"Unable to manage workspaces."});
  }
}