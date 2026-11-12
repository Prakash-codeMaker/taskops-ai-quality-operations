-- Promotion to workspace owner/admin retains reviewer capability and existing assignments.
-- Only downgrades to ordinary member/auditor deactivate reviewer profiles.
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
  v_reviewer_id UUID;
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

  SELECT id INTO v_reviewer_id
  FROM reviewers
  WHERE workspace_id=v_target.workspace_id
    AND user_id=v_target.user_id
    AND active=TRUE
  FOR UPDATE;

  IF v_reviewer_id IS NOT NULL AND p_new_role NOT IN ('owner','admin','reviewer','quality_lead') THEN
    IF EXISTS (
      SELECT 1 FROM tasks
      WHERE workspace_id=v_target.workspace_id
        AND assigned_to=v_reviewer_id
        AND status IN ('in_review','needs_revision','awaiting_approval')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'reviewer_has_open_tasks';
    END IF;
    UPDATE reviewers SET active=FALSE
    WHERE id=v_reviewer_id AND workspace_id=v_target.workspace_id;
  END IF;

  UPDATE workspace_memberships SET role=p_new_role
  WHERE id=p_membership_id;

  RETURN jsonb_build_object('membership_id',p_membership_id,'role',p_new_role);
END;
$$;