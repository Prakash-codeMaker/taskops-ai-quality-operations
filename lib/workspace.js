import { db } from "hatchable";

export async function requireWorkspace(req, res) {
  const userId = String(req.user?.id || "").trim();
  const email = String(req.user?.email || "").trim().toLowerCase();

  if (!userId) {
    res.status(401).json({ error: "A signed-in user is required." });
    return null;
  }

  const requestedWorkspaceId = String(req.query?.workspace_id || "").trim();
  if (requestedWorkspaceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedWorkspaceId)) {
    res.status(400).json({ error: "Invalid workspace identifier." });
    return null;
  }

  let result;
  try {
    result = await db.query(
      "SELECT taskops_get_or_create_workspace($1::text, $2::text, $3::uuid) AS workspace",
      [userId, email, requestedWorkspaceId || null]
    );
  } catch (error) {
    if (String(error?.message || "").includes("workspace_not_accessible")) {
      res.status(403).json({ error: "You do not have access to that workspace." });
      return null;
    }
    throw error;
  }

  const raw = result.rows[0]?.workspace;
  const workspace = typeof raw === "string" ? JSON.parse(raw) : raw;

  if (!workspace?.id || !workspace?.organization_id) {
    throw new Error("workspace_bootstrap_failed");
  }

  if (email) {
    await db.query(
      "UPDATE organization_memberships SET email=LOWER($1) WHERE user_id=$2 AND active=TRUE AND (email IS NULL OR email='')",
      [email,userId]
    ).catch(error => console.warn("workspace_email_backfill_failed",String(error?.message||error)));
  }
  return workspace;
}

export function requireRole(workspace, res, allowedRoles) {
  if (!allowedRoles.includes(workspace.role)) {
    res.status(403).json({ error: "Your organization role cannot perform this action." });
    return false;
  }
  return true;
}

export function workspaceSummary(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    organization_id: workspace.organization_id,
    organization_name: workspace.organization_name,
    role: workspace.role,
    organization_role: workspace.organization_role || workspace.role
  };
}