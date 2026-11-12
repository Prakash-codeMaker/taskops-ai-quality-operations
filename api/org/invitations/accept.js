import { db } from "hatchable";
import { requireWorkspace } from "lib/workspace.js";

export const access = "user";
export const methods = ["POST"];

async function hashToken(value) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}

export default async function(req,res) {
  const token=String(req.body?.token||"").trim();
  const email=String(req.user?.email||"").trim().toLowerCase();
  const userId=String(req.user?.id||"");
  if(token.length<40||token.length>200) return res.status(400).json({error:"Invitation token is invalid."});
  if(!email||!userId) return res.status(401).json({error:"Sign in using the invited email address."});
  try {
    const tokenHash=await hashToken(token);
    const result=await db.query(
      "SELECT taskops_accept_org_invitation($1::text,$2::text,$3::text) AS result",
      [tokenHash,userId,email]
    );
    const raw=result.rows[0]?.result;
    const invitation=typeof raw==="string"?JSON.parse(raw):raw;
    return res.json({accepted:true,invitation});
  } catch(error) {
    const message=String(error?.message||"");
    if(message.includes("invitation_invalid_or_expired")) return res.status(404).json({error:"This invitation is invalid, expired, already used, or belongs to a different email address."});
    console.error("invitation_accept_failed",error);
    return res.status(500).json({error:"Unable to accept invitation."});
  }
}