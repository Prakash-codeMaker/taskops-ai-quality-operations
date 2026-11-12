import { db } from "hatchable";

export const access = "scheduler";
export const methods = ["POST"];

function toTime(value) {
  if(value==null||value==="") return null;
  if(typeof value==="string"&&!/^\d{15,}$/.test(value)) {
    const d=new Date(value);
    return Number.isNaN(d.getTime())?null:d.toISOString();
  }
  const n=Number(value);
  if(!Number.isFinite(n)) return null;
  const ms=n>1e14?n/1e6:n>1e11?n:n*1000;
  const d=new Date(ms);
  return Number.isNaN(d.getTime())?null:d.toISOString();
}
function attributeValue(value) {
  if(value==null||typeof value!=="object") return value;
  for(const key of ["stringValue","string_value","intValue","int_value","doubleValue","double_value","boolValue","bool_value"]) {
    if(key in value) return value[key];
  }
  if(Array.isArray(value.arrayValue?.values)) return value.arrayValue.values.slice(0,20).map(attributeValue);
  if(value.kvlistValue?.values) return attrArray(value.kvlistValue.values);
  return "[structured-value]";
}
function attrArray(values) {
  if(!Array.isArray(values)) return values&&typeof values==="object"?values:{};
  const out={};
  for(const item of values.slice(0,120)) {
    if(!item?.key) continue;
    out[String(item.key).slice(0,120)]=attributeValue(item.value);
  }
  return out;
}
function flatten(body) {
  if(Array.isArray(body?.spans)) return body.spans;
  const out=[];
  for(const resource of body?.resourceSpans||[]) {
    const resourceAttrs=attrArray(resource.resource?.attributes||[]);
    for(const scope of resource.scopeSpans||resource.instrumentationLibrarySpans||[]) {
      for(const span of scope.spans||[]) out.push({...span,__resource_attributes:resourceAttrs});
    }
  }
  return out;
}
function sanitize(attrs) {
  const source=attrs&&typeof attrs==="object"?attrs:{};
  const out={};
  for(const [key,value] of Object.entries(source).slice(0,120)) {
    if(/authorization|api[_-]?key|password|secret|token|cookie|email|phone|prompt|completion|content\.value|raw_body|gen_ai\.(input\.messages(_ref)?|output\.messages(_ref)?|system_instructions(_ref)?|tool\.call\.(arguments|result)|retrieval\.query\.text|prompt\.variable(\.|$)|memory\.(query\.text|records))/i.test(key)) {
      out[key]="[REDACTED]";
    } else {
      const v=typeof value==="string"?value.slice(0,2000):value;
      out[key]=v;
    }
  }
  return out;
}

export default async function(req,res) {
  const batchId=String(req.body?.batch_id||"");
  if(!/^[0-9a-f-]{36}$/i.test(batchId)) return res.status(400).json({error:"batch_id is required."});
  try {
    const claim=await db.query(`
      UPDATE trace_ingest_batches SET status='processing'
      WHERE id=$1::uuid AND status='queued'
      RETURNING id,workspace_id,payload,span_count
    `,[batchId]);
    if(!claim.rows.length) {
      const current=await db.query("SELECT status,stored_count FROM trace_ingest_batches WHERE id=$1::uuid",[batchId]);
      return res.json({ok:true,already_claimed:true,status:current.rows[0]?.status||"missing",stored_count:current.rows[0]?.stored_count||0});
    }
    const batch=claim.rows[0];
    const spans=flatten(batch.payload);
    let stored=0,skipped=0;
    for(const span of spans.slice(0,250)) {
      const traceId=String(span.trace_id||span.traceId||"").trim().slice(0,128);
      const spanId=String(span.span_id||span.spanId||"").trim().slice(0,128);
      if(!traceId||!spanId) {skipped++;continue;}
      const started=toTime(span.start_time||span.startTime||span.startTimeUnixNano||span.start_time_unix_nano);
      const ended=toTime(span.end_time||span.endTime||span.endTimeUnixNano||span.end_time_unix_nano);
      const duration=started&&ended?Math.max(0,Math.round((new Date(ended)-new Date(started))*1000)/1000):null;
      const attrs=span.attributes&&!Array.isArray(span.attributes)?span.attributes:attrArray(span.attributes||[]);
      const resourceAttrs=span.__resource_attributes||{};
      const merged=sanitize({...resourceAttrs,...attrs});
      const result=await db.query(`
        INSERT INTO agent_traces(
          workspace_id,trace_id,span_id,parent_span_id,name,kind,status,attributes,
          started_at,ended_at,duration_ms
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
        ON CONFLICT(workspace_id,trace_id,span_id) DO NOTHING
        RETURNING id
      `,[
        batch.workspace_id,traceId,spanId,
        String(span.parent_span_id||span.parentSpanId||"").slice(0,128)||null,
        String(span.name||"unnamed span").slice(0,240),
        String(span.kind||"").slice(0,80)||null,
        String(span.status?.message||span.status?.code||span.status||"unknown").slice(0,80),
        JSON.stringify(merged),started,ended,duration
      ]);
      if(result.rows.length) stored++;
    }
    await db.query(`
      UPDATE trace_ingest_batches SET status='completed',stored_count=$1,
        error=$2,processed_at=NOW(),payload='{}'::jsonb
      WHERE id=$3::uuid
    `,[stored,skipped?"Skipped "+skipped+" span(s) without trace/span IDs.":null,batchId]);
    return res.json({ok:true,batch_id:batchId,stored,skipped});
  } catch(error) {
    console.error("trace_worker_failed",error);
    await db.query(`
      UPDATE trace_ingest_batches SET status='failed',error=$1,processed_at=NOW(),payload='{}'::jsonb
      WHERE id=$2::uuid
    `,[String(error?.message||"Trace worker failed").slice(0,500),batchId]).catch(()=>{});
    return res.status(500).json({error:"Trace processing failed."});
  }
}