import { db, email } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["GET","POST"];

function hex(bytes) {
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
}
async function hashToken(value) {
  const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return hex(digest);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

export default async function(req,res) {
  try {
    const workspace=await requireWorkspace(req,res);
    if(!workspace) return;
    if(!["owner","admin"].includes(workspace.organization_role)) {
      return res.status(403).json({error:"Organization admin role required."});
    }

    if(req.method==="GET") {
      const result=await db.query(`
        SELECT id,email,role,expires_at,created_at
        FROM organization_invitations
        WHERE organization_id=$1::uuid AND workspace_id=$2::uuid AND accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 50
      `,[workspace.organization_id,workspace.id]);
      return res.json({data:result.rows});
    }

    const emailAddress=String(req.body?.email||"").trim().toLowerCase();
    const role=String(req.body?.role||"member");
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) return res.status(400).json({error:"Enter a valid email address."});
    if(!["member","reviewer","quality_lead","auditor"].includes(role)) return res.status(400).json({error:"Invitations can grant member, reviewer, quality_lead or auditor access."});

    const existing=await db.query(
      "SELECT taskops_workspace_has_email($1::text,$2::uuid,$3::text) AS exists",
      [String(req.user.id),workspace.id,emailAddress]
    );
    if(existing.rows[0]?.exists) {
      return res.status(409).json({error:"That email already has access to this workspace."});
    }

    const token=crypto.randomUUID()+crypto.randomUUID();
    const tokenHash=await hashToken(token);
    const created=await db.query(`
      INSERT INTO organization_invitations(organization_id,workspace_id,email,role,token_hash,invited_by)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)
      ON CONFLICT(token_hash) DO NOTHING
      RETURNING id,email,role,expires_at
    `,[workspace.organization_id,workspace.id,emailAddress,role,tokenHash,String(req.user.id)]);
    const invitation=created.rows[0];
    if(!invitation) return res.status(500).json({error:"Invitation could not be created."});

    const inviteUrl="https://taskops-ai-data.hatchable.site/team.html?invite="+encodeURIComponent(token);
    let emailSent=false;
    let emailError=null;
    try {
      await email.send({
        to:emailAddress,
        subject:"You have been invited to TaskOps",
        text:"You have been invited to join "+workspace.organization_name+" / "+workspace.name+" in TaskOps as "+role+". Sign in with this email and open this invitation link: "+inviteUrl,
        html:"<p>You have been invited to join <strong>"+escapeHtml(workspace.organization_name)+" / "+escapeHtml(workspace.name)+"</strong> in TaskOps as <strong>"+escapeHtml(role)+"</strong>.</p><p>Sign in using this email address, then accept your invitation:</p><p><a href=\""+inviteUrl+"\">Accept TaskOps invitation</a></p><p>This link expires in seven days.</p>"
      });
      emailSent=true;
    } catch(error) {
      emailError=String(error?.message||"Email delivery is not configured for this recipient.").slice(0,240);
      console.warn("invitation_email_not_sent",emailError);
    }

    return res.status(201).json({
      invitation:{id:invitation.id,email:invitation.email,role:invitation.role,expires_at:invitation.expires_at},
      email_sent:emailSent,
      email_error:emailError,
      invite_url:emailSent?null:inviteUrl
    });
  } catch(error) {
    if(String(error?.message||"").toLowerCase().includes("unique")) {
      return res.status(409).json({error:"A pending invitation already exists for this email in the active workspace."});
    }
    console.error("org_invitation_failed",error);
    return res.status(500).json({error:"Unable to manage invitations."});
  }
}