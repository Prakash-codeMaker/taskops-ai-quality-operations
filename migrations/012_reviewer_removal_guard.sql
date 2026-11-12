-- Do not remove reviewers from scopes while they still own open work.
CREATE OR REPLACE FUNCTION taskops_remove_workspace_member(
  p_actor_user_id TEXT,
  p_membership_id UUID
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
    AND wm.user_id=p_actor_user_id AND wm.active=TRUE
    AND wm.role IN ('owner','admin')
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workspace_admin_required';
  END IF;

  IF v_actor_role<>'owner' AND v_target.role IN ('owner','admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workspace_owner_role_required';
  END IF;

  IF v_target.role='owner'
     AND (SELECT COUNT(*) FROM workspace_memberships
          WHERE workspace_id=v_target.workspace_id AND role='owner' AND active=TRUE)<=1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cannot_remove_last_workspace_owner';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM reviewers r
    JOIN tasks t ON t.workspace_id=r.workspace_id AND t.assigned_to=r.id
    WHERE r.workspace_id=v_target.workspace_id AND r.user_id=v_target.user_id
      AND r.active=TRUE
      AND t.status IN ('in_review','needs_revision','awaiting_approval')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'reviewer_has_open_tasks';
  END IF;

  UPDATE reviewers SET active=FALSE
  WHERE workspace_id=v_target.workspace_id AND user_id=v_target.user_id;
  UPDATE workspace_memberships SET active=FALSE WHERE id=p_membership_id;

  RETURN jsonb_build_object('removed',TRUE,'membership_id',p_membership_id);
END;
$$;

CREATE OR REPLACE FUNCTION taskops_remove_org_member(
  p_actor_user_id TEXT,
  p_membership_id UUID
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
  SELECT * INTO v_target FROM organization_memberships
  WHERE id=p_membership_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'member_not_found';
  END IF;

  SELECT role INTO v_actor_role FROM organization_memberships
  WHERE user_id=p_actor_user_id AND organization_id=v_target.organization_id
    AND active=TRUE AND role IN ('owner','admin')
  ORDER BY created_at LIMIT 1;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'organization_admin_required';
  END IF;
  IF v_actor_role<>'owner' AND v_target.role IN ('owner','admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner_role_required';
  END IF;
  IF v_target.role='owner'
     AND (SELECT COUNT(*) FROM organization_memberships
          WHERE organization_id=v_target.organization_id AND role='owner' AND active=TRUE)<=1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cannot_remove_last_owner';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM reviewers r
    JOIN tasks t ON t.workspace_id=r.workspace_id AND t.assigned_to=r.id
    JOIN workspaces w ON w.id=r.workspace_id
    WHERE w.organization_id=v_target.organization_id
      AND r.user_id=v_target.user_id AND r.active=TRUE
      AND t.status IN ('in_review','needs_revision','awaiting_approval')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'reviewer_has_open_tasks';
  END IF;

  UPDATE reviewers r SET active=FALSE
  FROM workspaces w
  WHERE w.id=r.workspace_id AND w.organization_id=v_target.organization_id
    AND r.user_id=v_target.user_id;

  UPDATE workspace_memberships SET active=FALSE
  WHERE user_id=v_target.user_id
    AND workspace_id IN (SELECT id FROM workspaces WHERE organization_id=v_target.organization_id);

  UPDATE organization_memberships SET active=FALSE WHERE id=p_membership_id;
  UPDATE organization_invitations SET revoked_at=NOW()
  WHERE organization_id=v_target.organization_id
    AND LOWER(email)=LOWER(COALESCE(v_target.email,''))
    AND accepted_at IS NULL AND revoked_at IS NULL;

  RETURN jsonb_build_object('removed',TRUE,'user_id',v_target.user_id);
END;
$$;