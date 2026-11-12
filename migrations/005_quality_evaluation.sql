-- Milestone 3: versioned schemas/rubrics, gold examples, evaluation runs and trace-ready quality data.

CREATE TABLE IF NOT EXISTS task_schemas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  schema_json JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id,name,version),
  UNIQUE (id,workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_task_schemas_active
  ON task_schemas(workspace_id,task_type,is_active,version DESC);

CREATE TABLE IF NOT EXISTS rubric_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  dimensions JSONB NOT NULL,
  pass_threshold NUMERIC(5,2) NOT NULL DEFAULT 85 CHECK (pass_threshold BETWEEN 0 AND 100),
  critical_floor NUMERIC(3,1) NOT NULL DEFAULT 2 CHECK (critical_floor BETWEEN 1 AND 5),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id,name,version),
  UNIQUE (id,workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_rubrics_active
  ON rubric_versions(workspace_id,is_active,created_at DESC);

CREATE TABLE IF NOT EXISTS gold_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  task_type TEXT NOT NULL,
  input_payload JSONB NOT NULL,
  expected_output JSONB NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id,workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_gold_examples_type
  ON gold_examples(workspace_id,task_type,is_active,created_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  requested_by TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('deterministic','ai','hybrid')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','partial','failed')),
  task_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (id,workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_workspace
  ON evaluation_runs(workspace_id,created_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL,
  task_id UUID NOT NULL,
  evaluator TEXT NOT NULL,
  model TEXT,
  score NUMERIC(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','revise','fail')),
  dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale TEXT NOT NULL DEFAULT '',
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id,task_id),
  FOREIGN KEY (run_id,workspace_id)
    REFERENCES evaluation_runs(id,workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id,workspace_id)
    REFERENCES tasks(id,workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_evaluation_results_workspace
  ON evaluation_results(workspace_id,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_evaluation_results_task
  ON evaluation_results(workspace_id,task_id,created_at DESC);

-- Return the user's own workspace list through a membership-verified function.
CREATE OR REPLACE FUNCTION taskops_list_user_workspaces(p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_d12a46b95461c0f3
AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',w.id,'name',w.name,'slug',w.slug,
      'organization_id',o.id,'organization_name',o.name,
      'role',wm.role,'created_at',wm.created_at
    ) ORDER BY wm.created_at ASC,w.name ASC)
    FROM workspace_memberships wm
    JOIN workspaces w ON w.id=wm.workspace_id
    JOIN organizations o ON o.id=w.organization_id
    JOIN organization_memberships om
      ON om.organization_id=o.id AND om.user_id=wm.user_id AND om.active=TRUE
    WHERE wm.user_id=p_user_id AND wm.active=TRUE
  ),'[]'::jsonb);
END;
$$;

-- Return workspace member IDs only after verifying that the caller belongs to that workspace.
CREATE OR REPLACE FUNCTION taskops_workspace_member_ids(
  p_actor_user_id TEXT,
  p_workspace_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_d12a46b95461c0f3
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id=p_workspace_id AND user_id=p_actor_user_id AND active=TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workspace_access_denied';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(user_id)
    FROM workspace_memberships
    WHERE workspace_id=p_workspace_id AND active=TRUE
  ),'[]'::jsonb);
END;
$$;

-- Add one default transparent rubric to every workspace that exists at migration time.
INSERT INTO rubric_versions(
  workspace_id,name,version,dimensions,pass_threshold,critical_floor,is_active,created_by
)
SELECT w.id,'TaskOps Default',1,
  '{"correctness":0.30,"completeness":0.20,"instruction_adherence":0.20,"format_validity":0.15,"evidence_quality":0.15}'::jsonb,
  85,2,TRUE,'system'
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM rubric_versions r
  WHERE r.workspace_id=w.id AND r.name='TaskOps Default' AND r.version=1
);