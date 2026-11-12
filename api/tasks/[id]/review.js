import { db } from "hatchable";
import { requireWorkspace, requireRole } from "lib/workspace.js";

export const access = "user";
export const methods = ["POST"];

const dimensionKeys = ["correctness","completeness","instruction_adherence","format_validity","evidence_quality"];

function round(value,places=2) {
  const factor=10**places;
  return Math.round(value*factor)/factor;
}

export default async function (req, res) {
  const taskId = String(req.params.id || "");
  const body = req.body || {};
  const dimensions = body.dimensions || {};
  const notes = String(body.notes || "").trim().slice(0,2000);
  const values = {};

  for (const key of dimensionKeys) {
    const value = Number(dimensions[key]);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      return res.status(400).json({error:`Dimension ${key} must be a number from 1 to 5.`});
    }
    values[key]=round(value,1);
  }

  try {
    const workspace=await requireWorkspace(req,res);
    if (!workspace) return;
    if (!requireRole(workspace,res,["owner","admin","reviewer","quality_lead"])) return;

    // Resolve the real submitting person's reviewer profile. Never attribute
    // an owner/quality-lead review to whichever reviewer happens to own the task.
    const profile=await db.query(
      "SELECT id FROM reviewers WHERE workspace_id=$1 AND user_id=$2 AND active=TRUE LIMIT 1",
      [workspace.id,String(req.user.id)]
    );
    const submittingReviewerId=workspace.role==="reviewer"?(profile.rows[0]?.id||null):null;

    if (workspace.role==="reviewer") {
      if (!submittingReviewerId) return res.status(403).json({error:"Your account is not registered as an active reviewer in this workspace."});
      const assigned=await db.query(
        "SELECT id FROM tasks WHERE id=$1::uuid AND workspace_id=$2::uuid AND assigned_to=$3::uuid AND status IN ('in_review','needs_revision') LIMIT 1",
        [taskId,workspace.id,submittingReviewerId]
      );
      if (!assigned.rows.length) return res.status(403).json({error:"Reviewers can only submit reviews for tasks assigned to their reviewer profile."});
    }

    const rubricResult=await db.query(`
      SELECT id,name,version,dimensions,pass_threshold,critical_floor
      FROM rubric_versions
      WHERE workspace_id=$1 AND is_active=TRUE
      ORDER BY created_at DESC,version DESC
      LIMIT 1
    `,[workspace.id]);
    if (!rubricResult.rows.length) {
      return res.status(409).json({error:"This workspace has no active quality rubric. Publish one in the Evaluation workbench first."});
    }

    const rubric=rubricResult.rows[0];
    const rubricWeights=rubric.dimensions&&typeof rubric.dimensions==="object"?rubric.dimensions:{};
    const weights={};
    for (const key of dimensionKeys) {
      const weight=Number(rubricWeights[key]);
      if (!Number.isFinite(weight)||weight<0||weight>1) {
        console.error("review_rubric_invalid",rubric.id,key);
        return res.status(409).json({error:"The active rubric has invalid dimension weights. Publish a corrected rubric before reviewing."});
      }
      weights[key]=weight;
    }
    const totalWeight=Object.values(weights).reduce((sum,value)=>sum+value,0);
    if (Math.abs(totalWeight-1)>0.001) {
      return res.status(409).json({error:"The active rubric weights do not sum to 1.0. Publish a corrected rubric before reviewing."});
    }

    const threshold=Number(rubric.pass_threshold);
    const criticalFloor=Number(rubric.critical_floor);
    if (!Number.isFinite(threshold)||threshold<0||threshold>100||
        !Number.isFinite(criticalFloor)||criticalFloor<1||criticalFloor>5) {
      return res.status(409).json({error:"The active rubric has an invalid decision policy. Publish a corrected rubric before reviewing."});
    }

    const score=round(dimensionKeys.reduce((sum,key)=>sum+values[key]*weights[key],0)/5*100);
    const hasCriticalGap=dimensionKeys.some(key=>values[key]<criticalFloor);
    const verdict=hasCriticalGap||score<50
      ?"fail"
      :score>=threshold&&dimensionKeys.every(key=>values[key]>=3)
        ?"pass"
        :"revise";
    const nextStatus=verdict==="pass"?"awaiting_approval":"needs_revision";
    const actor=String(req.user?.email||"authenticated-user");
    const rubricSnapshot={
      id:rubric.id,
      name:rubric.name,
      version:rubric.version,
      dimensions:weights,
      pass_threshold:threshold,
      critical_floor:criticalFloor
    };

    const result=await db.query(`
      WITH target AS (
        SELECT t.id,t.workspace_id,t.status,t.review_count,
          COALESCE((SELECT MAX(rv.attempt_number) FROM reviews rv
            WHERE rv.task_id=t.id AND rv.workspace_id=t.workspace_id),0) AS last_attempt
        FROM tasks t
        WHERE t.id=$1::uuid AND t.workspace_id=$17::uuid
          AND t.status IN ('in_review','needs_revision')
        FOR UPDATE
      ), inserted AS (
        INSERT INTO reviews (
          workspace_id,task_id,reviewer_id,rubric_id,rubric_snapshot,
          submitted_by,submitted_by_email,rubric_version,attempt_number,
          correctness,completeness,instruction_adherence,format_validity,evidence_quality,
          overall_score,verdict,notes
        )
        SELECT workspace_id,id,$2::uuid,$3::uuid,$4::jsonb,
          $5,$6,$7,last_attempt+1,
          $8,$9,$10,$11,$12,$13,$14,$15
        FROM target
        RETURNING id,task_id,workspace_id,overall_score,verdict,rubric_version
      ), changed AS (
        UPDATE tasks t SET
          status=$16,
          quality_score=$13,
          latest_verdict=$14,
          review_count=t.review_count+1,
          updated_at=NOW()
        FROM inserted i
        WHERE t.id=i.task_id AND t.workspace_id=i.workspace_id
        RETURNING t.id,t.workspace_id,t.external_id,t.title,t.status,
          i.id AS review_id,i.overall_score,i.verdict,i.rubric_version
      ), logged AS (
        INSERT INTO task_events (
          workspace_id,task_id,actor,action,from_status,to_status,metadata
        )
        SELECT c.workspace_id,c.id,$6,'review_submitted',target.status,c.status,
          jsonb_build_object(
            'review_id',c.review_id,
            'score',c.overall_score,
            'verdict',c.verdict,
            'rubric_id',$3::uuid,
            'rubric_version',$7::text,
            'submitted_by',$5::text
          )
        FROM changed c JOIN target ON target.id=c.id
        RETURNING task_id
      )
      SELECT changed.* FROM changed JOIN logged ON logged.task_id=changed.id
    `,[
      taskId,
      submittingReviewerId,
      rubric.id,
      JSON.stringify(rubricSnapshot),
      String(req.user.id),
      actor,
      "v"+String(rubric.version),
      values.correctness,
      values.completeness,
      values.instruction_adherence,
      values.format_validity,
      values.evidence_quality,
      score,
      verdict,
      notes,
      nextStatus,
      workspace.id
    ]);

    if (!result.rows.length) {
      return res.status(409).json({error:"Task must be in review or need revision before a review can be submitted."});
    }
    return res.status(201).json({
      result:result.rows[0],
      rubric:{id:rubric.id,name:rubric.name,version:rubric.version,weights,threshold,critical_dimension_floor:criticalFloor}
    });
  } catch(error) {
    console.error("review_submit_failed",error);
    return res.status(500).json({error:"Unable to submit review."});
  }
}