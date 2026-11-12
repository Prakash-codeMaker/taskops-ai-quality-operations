-- Ensure every workspace, including ones created after this migration, starts with a versioned default rubric.

CREATE OR REPLACE FUNCTION taskops_seed_default_rubric_for_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO rubric_versions(
    workspace_id,name,version,dimensions,pass_threshold,critical_floor,is_active,created_by
  )
  SELECT
    NEW.id,
    'TaskOps Default',
    1,
    '{"correctness":0.30,"completeness":0.20,"instruction_adherence":0.20,"format_validity":0.15,"evidence_quality":0.15}'::jsonb,
    85,
    2,
    TRUE,
    'system'
  WHERE NOT EXISTS (
    SELECT 1 FROM rubric_versions
    WHERE workspace_id=NEW.id AND name='TaskOps Default' AND version=1
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspaces_seed_default_rubric ON workspaces;
CREATE TRIGGER workspaces_seed_default_rubric
AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION taskops_seed_default_rubric_for_workspace();

INSERT INTO rubric_versions(
  workspace_id,name,version,dimensions,pass_threshold,critical_floor,is_active,created_by
)
SELECT
  w.id,
  'TaskOps Default',
  1,
  '{"correctness":0.30,"completeness":0.20,"instruction_adherence":0.20,"format_validity":0.15,"evidence_quality":0.15}'::jsonb,
  85,
  2,
  TRUE,
  'system'
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM rubric_versions r
  WHERE r.workspace_id=w.id AND r.name='TaskOps Default' AND r.version=1
);