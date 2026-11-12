-- Milestone 2 completion: keep organization roles separate from workspace roles
-- and make reviewer profiles manageable within every workspace.

ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviewers_workspace_user
  ON reviewers(workspace_id,user_id)
  WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION taskops_change_member_role(
  p_actor_user_id TEXT,
  p_membership_id UUID,
  p_new_role TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_d12a46b95461c0f3
AS $$
DECLARE
  v_actor_role TEXT;
  v_target organization_memberships%ROWTYPE;
BEGIN
  IF p_new_role NOT IN ('owner','admin','member') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_organization_role';
  END IF;

  SELECT * INTO v_target
  FROM organization_memberships
  WHERE id=p_membership_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'member_not_found';
  END IF;

  SELECT role INTO v_actor_role
  FROM organization_memberships
  WHERE user_id=p_actor_user_id
    AND organization_id=v_target.organization_id
    AND active=TRUE
    AND role IN ('owner','admin')
  ORDER BY created_at
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'organization_admin_required';
  END IF;

  IF v_actor_role <> 'owner'
    AND (p_new_role IN ('owner','admin') OR v_target.role IN ('owner','admin')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner_role_required';
  END IF;

  IF v_target.role='owner' AND p_new_role<>'owner'
     AND (SELECT COUNT(*) FROM organization_memberships
          WHERE organization_id=v_target.organization_id AND role='owner' AND active=TRUE) <= 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cannot_remove_last_owner';
  END IF;

  UPDATE organization_memberships SET role=p_new_role
  WHERE id=p_membership_id;

  RETURN jsonb_build_object('membership_id',p_membership_id,'role',p_new_role);
END;
$$;

CREATE OR REPLACE FUNCTION taskops_change_workspace_member_role(
  p_actor_user_id TEXT,
  p_membership_id UUID,
  p_new_role TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_d12a46b95461c0f3
AS $$
DECLARE
  v_actor_role TEXT;
  v_target workspace_memberships%ROWTYPE;
  v_organization_id UUID;
BEGIN
  IF p_new_role NOT IN ('owner','admin','member','reviewer','quality_lead','auditor') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_workspace_role';
  END IF;

  SELECT * INTO v_target
  FROM workspace_memberships
  WHERE id=p_membership_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'workspace_member_not_found';
  END IF;

  SELECT organization_id INTO v_organization_id
  FROM workspaces WHERE id=v_target.workspace_id;

  SELECT wm.role INTO v_actor_role
  FROM workspace_memberships wm
  JOIN organization_memberships om
    ON om.organization_id=v_organization_id
    AND om.user_id=wm.user_id AND om.active=TRUE
  WHERE wm.workspace_id=v_target.workspace_id
    AND wm.user_id=p_actor_user_id
    AND wm.active=TRUE
    AND wm.role IN ('owner','admin')
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workspace_admin_required';
  END IF;

  IF v_actor_role <> 'owner'
    AND (p_new_role IN ('owner','admin') OR v_target.role IN ('owner','admin')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workspace_owner_role_required';
  END IF;

  IF v_target.role='owner' AND p_new_role<>'owner'
     AND (SELECT COUNT(*) FROM workspace_memberships
          WHERE workspace_id=v_target.workspace_id AND role='owner' AND active=TRUE) <= 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cannot_remove_last_workspace_owner';
  END IF;

  UPDATE workspace_memberships SET role=p_new_role
  WHERE id=p_membership_id;

  RETURN jsonb_build_object('membership_id',p_membership_id,'role',p_new_role);
END;
$$;