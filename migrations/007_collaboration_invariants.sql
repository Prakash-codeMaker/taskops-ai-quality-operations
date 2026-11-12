-- Milestone 2 follow-up: protect workspace invitations and expose workspace-local membership.

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_workspace_invite_email
  ON organization_invitations(workspace_id,LOWER(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION taskops_workspace_has_email(
  p_actor_user_id TEXT,
  p_workspace_id UUID,
  p_email TEXT
)
RETURNS BOOLEAN
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
  RETURN EXISTS (
    SELECT 1
    FROM workspace_memberships wm
    JOIN organization_memberships om
      ON om.organization_id=(SELECT organization_id FROM workspaces WHERE id=p_workspace_id)
      AND om.user_id=wm.user_id AND om.active=TRUE
    WHERE wm.workspace_id=p_workspace_id AND wm.active=TRUE
      AND LOWER(COALESCE(om.email,''))=LOWER(COALESCE(p_email,''))
  );
END;
$$;

CREATE OR REPLACE FUNCTION taskops_list_workspace_members(
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
    SELECT jsonb_agg(jsonb_build_object(
      'id',wm.id,'user_id',wm.user_id,'email',om.email,'role',wm.role,
      'active',wm.active,'created_at',wm.created_at
    ) ORDER BY wm.created_at ASC)
    FROM workspace_memberships wm
    LEFT JOIN organization_memberships om
      ON om.organization_id=(SELECT organization_id FROM workspaces WHERE id=p_workspace_id)
      AND om.user_id=wm.user_id
    WHERE wm.workspace_id=p_workspace_id
  ),'[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION taskops_accept_org_invitation(
  p_token_hash TEXT,
  p_user_id TEXT,
  p_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_d12a46b95461c0f3
AS $$
DECLARE
  v_invite organization_invitations%ROWTYPE;
  v_workspace workspaces%ROWTYPE;
BEGIN
  SELECT * INTO v_invite FROM organization_invitations
  WHERE token_hash=p_token_hash
    AND LOWER(email)=LOWER(COALESCE(p_email,''))
    AND accepted_at IS NULL AND revoked_at IS NULL
    AND expires_at>NOW()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'invitation_invalid_or_expired';
  END IF;

  UPDATE organization_invitations
  SET accepted_by=p_user_id,accepted_at=NOW(),token_hash='used-' || id::text
  WHERE id=v_invite.id;

  INSERT INTO organization_memberships(organization_id,user_id,email,role,active)
  VALUES(v_invite.organization_id,p_user_id,LOWER(p_email),'member',TRUE)
  ON CONFLICT(organization_id,user_id)
  DO UPDATE SET email=EXCLUDED.email,active=TRUE;

  INSERT INTO workspace_memberships(workspace_id,user_id,role,active)
  VALUES(v_invite.workspace_id,p_user_id,v_invite.role,TRUE)
  ON CONFLICT(workspace_id,user_id)
  DO UPDATE SET role=EXCLUDED.role,active=TRUE;

  SELECT * INTO v_workspace FROM workspaces WHERE id=v_invite.workspace_id;
  RETURN jsonb_build_object(
    'workspace_id',v_workspace.id,
    'workspace_name',v_workspace.name,
    'organization_id',v_workspace.organization_id,
    'role',v_invite.role
  );
END;
$$;