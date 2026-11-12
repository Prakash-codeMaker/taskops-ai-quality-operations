-- Milestone 1: establish workspace/organization ownership and tenant-scoped records.
-- Existing demo records are retained and backfilled into the Atlas Demo workspace.

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  slug TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  slug TEXT NOT NULL,
  is_template BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, slug),
  UNIQUE (id, organization_id)
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner','admin','member','reviewer','quality_lead','auditor')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memberships_user_active
  ON organization_memberships(user_id, active, created_at);

CREATE INDEX IF NOT EXISTS idx_workspaces_org
  ON workspaces(organization_id, created_at);

INSERT INTO organizations (name, slug, created_by)
VALUES ('TaskOps Demo', 'taskops-demo', 'system')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO workspaces (organization_id, name, slug, is_template)
SELECT id, 'Atlas Workspace', 'atlas-demo', TRUE
FROM organizations
WHERE slug = 'taskops-demo'
ON CONFLICT (organization_id, slug) DO NOTHING;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- Temporarily lift append-only triggers only while backfilling the new scope key.
DROP TRIGGER IF EXISTS task_events_append_only ON task_events;
DROP TRIGGER IF EXISTS reviews_append_only ON reviews;

UPDATE tasks
SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'atlas-demo' LIMIT 1)
WHERE workspace_id IS NULL;

UPDATE reviewers
SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'atlas-demo' LIMIT 1)
WHERE workspace_id IS NULL;

UPDATE reviews rv
SET workspace_id = t.workspace_id
FROM tasks t
WHERE rv.task_id = t.id AND rv.workspace_id IS NULL;

UPDATE task_events ev
SET workspace_id = t.workspace_id
FROM tasks t
WHERE ev.task_id = t.id AND ev.workspace_id IS NULL;

UPDATE import_batches
SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'atlas-demo' LIMIT 1)
WHERE workspace_id IS NULL;

ALTER TABLE tasks ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE reviewers ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE reviews ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE task_events ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE import_batches ALTER COLUMN workspace_id SET NOT NULL;

-- Re-enable append-only guarantees after the one-time workspace backfill.
CREATE TRIGGER task_events_append_only
BEFORE UPDATE OR DELETE ON task_events
FOR EACH ROW EXECUTE FUNCTION taskops_block_audit_mutation();

CREATE TRIGGER reviews_append_only
BEFORE UPDATE OR DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION taskops_block_audit_mutation();

ALTER TABLE tasks
  ADD CONSTRAINT tasks_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;

ALTER TABLE reviewers
  ADD CONSTRAINT reviewers_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;

ALTER TABLE task_events
  ADD CONSTRAINT task_events_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;

ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;

-- Composite keys and constraints prevent records from crossing workspace boundaries.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_id_workspace_key UNIQUE (id, workspace_id);

ALTER TABLE reviewers
  ADD CONSTRAINT reviewers_id_workspace_key UNIQUE (id, workspace_id);

ALTER TABLE tasks
  ADD CONSTRAINT tasks_assignee_workspace_fkey
  FOREIGN KEY (assigned_to, workspace_id)
  REFERENCES reviewers(id, workspace_id) ON DELETE RESTRICT;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_task_workspace_fkey
  FOREIGN KEY (task_id, workspace_id)
  REFERENCES tasks(id, workspace_id) ON DELETE RESTRICT;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_reviewer_workspace_fkey
  FOREIGN KEY (reviewer_id, workspace_id)
  REFERENCES reviewers(id, workspace_id) ON DELETE RESTRICT;

ALTER TABLE task_events
  ADD CONSTRAINT task_events_task_workspace_fkey
  FOREIGN KEY (task_id, workspace_id)
  REFERENCES tasks(id, workspace_id) ON DELETE RESTRICT;

-- Previously these identifiers were globally unique. They now only need to be
-- unique inside one workspace.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_external_id_key;
ALTER TABLE reviewers DROP CONSTRAINT IF EXISTS reviewers_email_key;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_workspace_external_id_key UNIQUE (workspace_id, external_id);

ALTER TABLE reviewers
  ADD CONSTRAINT reviewers_workspace_email_key UNIQUE (workspace_id, email);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status_created
  ON tasks(workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_assignee
  ON tasks(workspace_id, assigned_to, status);

CREATE INDEX IF NOT EXISTS idx_reviewers_workspace_active
  ON reviewers(workspace_id, active, name);

CREATE INDEX IF NOT EXISTS idx_reviews_workspace_task
  ON reviews(workspace_id, task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_workspace_created
  ON task_events(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_batches_workspace_created
  ON import_batches(workspace_id, created_at DESC);

-- A signed-in end user gets their existing membership, claims the demo template
-- once (real accounts only), or receives a fresh isolated organization/workspace.
-- The platform's synthetic test identity intentionally gets its own empty workspace.
CREATE OR REPLACE FUNCTION taskops_get_or_create_workspace(
  p_user_id TEXT,
  p_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_membership RECORD;
  v_workspace workspaces%ROWTYPE;
  v_organization_id UUID;
  v_name TEXT;
  v_slug TEXT;
BEGIN
  IF p_user_id IS NULL OR BTRIM(p_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user_id_required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id, 0));

  SELECT
    w.id,
    w.name AS name,
    w.slug AS slug,
    o.id AS organization_id,
    o.name AS organization_name,
    m.role
  INTO v_membership
  FROM organization_memberships m
  JOIN organizations o ON o.id = m.organization_id
  JOIN workspaces w ON w.organization_id = o.id
  WHERE m.user_id = p_user_id AND m.active = TRUE
  ORDER BY m.created_at ASC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'id', v_membership.id,
      'name', v_membership.name,
      'slug', v_membership.slug,
      'organization_id', v_membership.organization_id,
      'organization_name', v_membership.organization_name,
      'role', v_membership.role
    );
  END IF;

  IF LOWER(COALESCE(p_email, '')) NOT LIKE '%@test.invalid' THEN
    SELECT * INTO v_workspace
    FROM workspaces
    WHERE is_template = TRUE AND claimed_by IS NULL
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF FOUND THEN
      UPDATE workspaces
      SET is_template = FALSE, claimed_by = p_user_id
      WHERE id = v_workspace.id;

      INSERT INTO organization_memberships (organization_id, user_id, role)
      VALUES (v_workspace.organization_id, p_user_id, 'owner');

      SELECT
        w.id,
        w.name AS name,
        w.slug AS slug,
        o.id AS organization_id,
        o.name AS organization_name,
        'owner'::text AS role
      INTO v_membership
      FROM workspaces w
      JOIN organizations o ON o.id = w.organization_id
      WHERE w.id = v_workspace.id;

      RETURN jsonb_build_object(
        'id', v_membership.id,
        'name', v_membership.name,
        'slug', v_membership.slug,
        'organization_id', v_membership.organization_id,
        'organization_name', v_membership.organization_name,
        'role', v_membership.role
      );
    END IF;
  END IF;

  v_name := LEFT(
    COALESCE(NULLIF(SPLIT_PART(COALESCE(p_email, ''), '@', 1), ''), 'My') || ' Organization',
    120
  );
  v_slug := 'org-' || SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 12);

  INSERT INTO organizations (name, slug, created_by)
  VALUES (v_name, v_slug, p_user_id)
  RETURNING id INTO v_organization_id;

  INSERT INTO workspaces (organization_id, name, slug)
  VALUES (v_organization_id, 'My Workspace', 'main')
  RETURNING * INTO v_workspace;

  INSERT INTO organization_memberships (organization_id, user_id, role)
  VALUES (v_organization_id, p_user_id, 'owner');

  RETURN jsonb_build_object(
    'id', v_workspace.id,
    'name', v_workspace.name,
    'slug', v_workspace.slug,
    'organization_id', v_organization_id,
    'organization_name', v_name,
    'role', 'owner'
  );
END;
$$;

-- Replace the single-workspace assignment function with a workspace-aware version.
DROP FUNCTION IF EXISTS taskops_assign_task(uuid, uuid, text);

CREATE OR REPLACE FUNCTION taskops_assign_task(
  p_task_id uuid,
  p_reviewer_id uuid,
  p_actor text,
  p_workspace_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_reviewer reviewers%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_open_count integer;
  v_previous_status text;
BEGIN
  IF p_task_id IS NULL OR p_reviewer_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'task_reviewer_workspace_required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_reviewer_id::text, 0));

  SELECT * INTO v_reviewer
  FROM reviewers
  WHERE id = p_reviewer_id
    AND workspace_id = p_workspace_id
    AND active = TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'reviewer_not_found';
  END IF;

  SELECT COUNT(*)::integer INTO v_open_count
  FROM tasks
  WHERE workspace_id = p_workspace_id
    AND assigned_to = p_reviewer_id
    AND status IN ('in_review', 'needs_revision', 'awaiting_approval')
    AND id <> p_task_id;

  IF v_open_count >= v_reviewer.capacity THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reviewer_at_capacity';
  END IF;

  SELECT * INTO v_task
  FROM tasks
  WHERE id = p_task_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task_not_found';
  END IF;

  IF v_task.status NOT IN ('queued', 'needs_revision') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task_not_assignable';
  END IF;

  v_previous_status := v_task.status;

  UPDATE tasks
  SET assigned_to = p_reviewer_id,
      status = 'in_review',
      updated_at = NOW()
  WHERE id = p_task_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_task;

  INSERT INTO task_events (
    workspace_id, task_id, actor, action, from_status, to_status, metadata
  ) VALUES (
    p_workspace_id,
    v_task.id,
    COALESCE(NULLIF(BTRIM(p_actor), ''), 'authenticated-user'),
    'reviewer_assigned',
    v_previous_status,
    'in_review',
    jsonb_build_object(
      'reviewer_id', v_reviewer.id::text,
      'reviewer_name', v_reviewer.name,
      'assignment_method', 'capacity_locked'
    )
  );

  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'reviewer', jsonb_build_object(
      'id', v_reviewer.id,
      'name', v_reviewer.name,
      'capacity', v_reviewer.capacity,
      'active', v_reviewer.active
    )
  );
END;
$$;