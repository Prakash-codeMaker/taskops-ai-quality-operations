import { db, scheduler } from "hatchable";

export const access = "public";
export const methods = ["POST"];

async function hashToken(value) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
function redact(value,depth=0) {
  if(depth>12) return "[depth-limited]";
  if(Array.isArray(value)) return value.slice(0,250).map(x=>redact(x,depth+1));
  if(value&&typeof value==="object") {
    // OTLP KeyValue attributes encode sensitive data as {key,value}; redact
    // by the attribute key BEFORE the raw batch is persisted in the queue.
    if(typeof value.key==="string" && /authorization|api[_-]?key|password|secret|token|cookie|email|phone|prompt|completion|content\.value|raw_body|gen_ai\.(input\.messages(_ref)?|output\.messages(_ref)?|system_instructions(_ref)?|tool\.call\.(arguments|result)|retrieval\.query\.text|prompt\.variable(\.|$)|memory\.(query\.text|records))/i.test(value.key)) {
      return {key:value.key,value:{stringValue:"[REDACTED]"}};
    }
    const out={};
    for(const [key,item] of Object.entries(value).slice(0,120)) {
      if(/authorization|api[_-]?key|password|secret|token|cookie|email|phone|prompt|completion|content\.value|raw_body|gen_ai\.(input\.messages(_ref)?|output\.messages(_ref)?|system_instructions(_ref)?|tool\.call\.(arguments|result)|retrieval\.query\.text|prompt\.variable(\.|$)|memory\.(query\.text|records))/i.test(key)) {
        out[key]="[REDACTED]";
      } else out[key]=redact(item,depth+1);
    }
    return out;
  }
  if(typeof value==="string") return value.slice(0,4000);
  return value;
}
function countSpans(body) {
  if(Array.isArray(body?.spans)) return body.spans.length;
  let count=0;
  for(const resource of body?.resourceSpans||[]) {
    for(const scope of resource.scopeSpans||resource.instrumentationLibrarySpans||[]) count+=(scope.spans||[]).length;
  }
  return count;
}

export default async function(req,res) {
  const header=String(req.headers?.authorization||"");
  const match=header.match(/^Bearer\s+(taskops_live_[A-Za-z0-9_-]{40,100})$/i);
  if(!match) return res.status(401).json({error:"A valid TaskOps integration bearer token is required."});
  try {
    const tokenHash=await hashToken(match[1]);
    const tokenResult=await db.query(`
      SELECT id,workspace_id,scopes FROM integration_tokens
      WHERE token_hash=$1 AND is_active=TRUE
      LIMIT 1
    `,[tokenHash]);
    if(!tokenResult.rows.length) return res.status(401).json({error:"Integration token is invalid or revoked."});

    const token=tokenResult.rows[0];
    const scopes=Array.isArray(token.scopes)?token.scopes:[];
    if(!scopes.includes("traces:write")) return res.status(403).json({error:"This integration key does not have traces:write scope."});
    const body=req.body&&typeof req.body==="object"?req.body:{};
    const count=countSpans(body);
    if(count<1) return res.status(400).json({error:"Provide spans[] or OTLP resourceSpans with at least one span."});
    if(count>250) return res.status(413).json({error:"A trace batch is limited to 250 spans."});
    const safePayload=redact(body);
    const size=JSON.stringify(safePayload).length;
    if(size>750000) return res.status(413).json({error:"Trace batch exceeds 750 KB after redaction."});

    const inserted=await db.query(`
      INSERT INTO trace_ingest_batches(workspace_id,token_id,source,payload,status,span_count)
      VALUES($1,$2,$3,$4::jsonb,'queued',$5)
      RETURNING id,status,span_count,received_at
    `,[token.workspace_id,token.id,String(body.source||"otel-json").slice(0,80),JSON.stringify(safePayload),count]);
    await db.query("UPDATE integration_tokens SET last_used_at=NOW() WHERE id=$1",[token.id]);

    try {
      await scheduler.now("/api/jobs/process-traces",{batch_id:inserted.rows[0].id});
    } catch(error) {
      await db.query("UPDATE trace_ingest_batches SET status='failed',error=$1,processed_at=NOW() WHERE id=$2",
        [String(error?.message||"Trace worker could not be scheduled").slice(0,500),inserted.rows[0].id]);
      return res.status(503).json({error:"Trace batch was recorded but could not be scheduled for processing.",batch_id:inserted.rows[0].id});
    }
    return res.status(202).json({accepted:true,batch:inserted.rows[0]});
  } catch(error) {
    console.error("trace_ingest_failed",error);
    return res.status(500).json({error:"Unable to ingest trace batch."});
  }
}