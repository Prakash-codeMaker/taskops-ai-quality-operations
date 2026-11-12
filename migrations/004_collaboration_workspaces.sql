-- Milestone 2: workspace membership, invitations, switching and organization member administration.
ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS email TEXT;

UPDATE organization_memberships m
SET email = COALESCE(m.email, u.email)
FROM users u
WHERE (u.id = m.user_id OR u.hatchable_user_id = m.user_id)
  AND m.email IS NULL;

CREATE TABLE IF NOT EXISTS workspace_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner','admin','member','reviewer','quality_lead','auditor')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user
  ON workspace_memberships(user_id, active, created_at);

INSERT INTO workspace_memberships (workspace_id,user_id,role,active)
SELECT w.id,m.user_id,
       CASE WHEN m.role IN ('owner','admin') THEN m.role ELSE m.role END,
       m.active
FROM organization_memberships m
JOIN workspaces w ON w.organization_id=m.organization_id
ON CONFLICT (workspace_id,user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS organization_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member','reviewer','quality_lead','auditor')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_by TEXT,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_invites_pending
  ON organization_invitations(organization_id,email,expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

DROP FUNCTION IF EXISTS taskops_get_or_create_workspace(text,text);
CREATE OR REPLACE FUNCTION taskops_get_or_create_workspace(
  p_user_id TEXT,
  p_email TEXT,
  p_requested_workspace_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_d12a46b95461c0f3
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
    w.id, w.name, w.slug, o.id AS organization_id, o.name AS organization_name,
    wm.role, om.role AS organization_role
  INTO v_membership
  FROM workspace_memberships wm
  JOIN workspaces w ON w.id=wm.workspace_id
  JOIN organization_memberships om ON om.organization_id=w.organization_id
    AND om.user_id=wm.user_id AND om.active=TRUE
  JOIN organizations o ON o.id=w.organization_id
  WHERE wm.user_id=p_user_id AND wm.active=TRUE
    AND (p_requested_workspace_id IS NULL OR wm.workspace_id=p_requested_workspace_id)
  ORDER BY wm.created_at ASC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'id',v_membership.id,'name',v_membership.name,'slug',v_membership.slug,
      'organization_id',v_membership.organization_id,
      'organization_name',v_membership.organization_name,
      'role',v_membership.role,'organization_role',v_membership.organization_role
    );
  END IF;

  IF p_requested_workspace_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'workspace_not_accessible';
  END IF;

  IF LOWER(COALESCE(p_email,'')) NOT LIKE '%@test.invalid' THEN
    SELECT * INTO v_workspace
    FROM workspaces
    WHERE is_template=TRUE AND claimed_by IS NULL
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF FOUND THEN
      UPDATE workspaces SET is_template=FALSE,claimed_by=p_user_id WHERE id=v_workspace.id;
      INSERT INTO organization_memberships (organization_id,user_id,email,role,active)
      VALUES (v_workspace.organization_id,p_user_id,LOWER(p_email),'owner',TRUE)
      ON CONFLICT (organization_id,user_id)
      DO UPDATE SET email=EXCLUDED.email,active=TRUE;
      INSERT INTO workspace_memberships (workspace_id,user_id,role,active)
      VALUES (v_workspace.id,p_user_id,'owner',TRUE)
      ON CONFLICT (workspace_id,user_id) DO UPDATE SET active=TRUE,role='owner';

      SELECT w.id,w.name,w.slug,o.id AS organization_id,o.name AS organization_name,
        wm.role,om.role AS organization_role
      INTO v_membership
      FROM workspace_memberships wm
      JOIN workspaces w ON w.id=wm.workspace_id
      JOIN organizations o ON o.id=w.organization_id
      JOIN organization_memberships om ON om.organization_id=o.id AND om.user_id=wm.user_id
      WHERE wm.workspace_id=v_workspace.id AND wm.user_id=p_user_id;

      RETURN jsonb_build_object(
        'id',v_membership.id,'name',v_membership.name,'slug',v_membership.slug,
        'organization_id',v_membership.organization_id,
        'organization_name',v_membership.organization_name,
        'role',v_membership.role,'organization_role',v_membership.organization_role
      );
    END IF;
  END IF;

  v_name := LEFT(COALESCE(NULLIF(SPLIT_PART(COALESCE(p_email,''),'@',1),''),'My') || ' Organization',120);
  v_slug := 'org-' || SUBSTR(REPLACE(gen_random_uuid()::text,'-',''),1,12);

  INSERT INTO organizations(name,slug,created_by)
  VALUES(v_name,v_slug,p_user_id) RETURNING id INTO v_organization_id;

  INSERT INTO workspaces(organization_id,name,slug)
  VALUES(v_organization_id,'My Workspace','main') RETURNING * INTO v_workspace;

  INSERT INTO organization_memberships(organization_id,user_id,email,role,active)
  VALUES(v_organization_id,p_user_id,LOWER(COALESCE(p_email,'')),'owner',TRUE);

  INSERT INTO workspace_memberships(workspace_id,user_id,role,active)
  VALUES(v_workspace.id,p_user_id,'owner',TRUE);

  RETURN jsonb_build_object(
    'id',v_workspace.id,'name',v_workspace.name,'slug',v_workspace.slug,
    'organization_id',v_organization_id,'organization_name',v_name,
    'role','owner','organization_role','owner'
  );
END;
$$;

CREATE OR REPLACE FUNCTION taskops_list_org_members(
  p_actor_user_id TEXT,
  p_workspace_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_d12a46b95461c0f3
AS $$
DECLARE
  v_org UUID;
BEGIN
  SELECT organization_id INTO v_org FROM workspaces WHERE id=p_workspace_id;
  IF v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE organization_id=v_org AND user_id=p_actor_user_id AND active=TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'organization_access_denied';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',m.id,'user_id',m.user_id,'email',m.email,'role',m.role,
      'active',m.active,'created_at',m.created_at
    ) ORDER BY m.created_at ASC)
    FROM organization_memberships m
    WHERE m.organization_id=v_org
  ),'[]'::jsonb);
END;
$$;

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
  IF p_new_role NOT IN ('owner','admin','member','reviewer','quality_lead','auditor') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_role';
  END IF;

  SELECT role INTO v_actor_role FROM organization_memberships
  WHERE user_id=p_actor_user_id AND active=TRUE AND role IN ('owner','admin')
    AND organization_id=(SELECT organization_id FROM organization_memberships WHERE id=p_membership_id)
  ORDER BY created_at LIMIT 1;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'organization_admin_required';
  END IF;

  SELECT * INTO v_target FROM organization_memberships
  WHERE id=p_membership_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'member_not_found';
  END IF;

  IF v_actor_role <> 'owner' AND (p_new_role IN ('owner','admin') OR v_target.role IN ('owner','admin')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner_role_required';
  END IF;
  IF v_target.role='owner' AND p_new_role<>'owner'
     AND (SELECT COUNT(*) FROM organization_memberships
          WHERE organization_id=v_target.organization_id AND role='owner' AND active=TRUE) <= 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cannot_remove_last_owner';
  END IF;

  UPDATE organization_memberships SET role=p_new_role
  WHERE id=p_membership_id;
  UPDATE workspace_memberships SET role=p_new_role
  WHERE user_id=v_target.user_id
    AND workspace_id IN (SELECT id FROM workspaces WHERE organization_id=v_target.organization_id);

  RETURN jsonb_build_object('membership_id',p_membership_id,'role',p_new_role);
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
  SELECT role INTO v_actor_role FROM organization_memberships
  WHERE user_id=p_actor_user_id AND active=TRUE AND role IN ('owner','admin')
    AND organization_id=(SELECT organization_id FROM organization_memberships WHERE id=p_membership_id)
  ORDER BY created_at LIMIT 1;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'organization_admin_required';
  END IF;

  SELECT * INTO v_target FROM organization_memberships
  WHERE id=p_membership_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'member_not_found';
  END IF;
  IF v_actor_role <> 'owner' AND v_target.role IN ('owner','admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner_role_required';
  END IF;
  IF v_target.role='owner'
     AND (SELECT COUNT(*) FROM organization_memberships
          WHERE organization_id=v_target.organization_id AND role='owner' AND active=TRUE) <= 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cannot_remove_last_owner';
  END IF;

  UPDATE workspace_memberships SET active=FALSE
  WHERE user_id=v_target.user_id
    AND workspace_id IN (SELECT id FROM workspaces WHERE organization_id=v_target.organization_id);
  UPDATE organization_memberships SET active=FALSE WHERE id=p_membership_id;
  UPDATE organization_invitations SET revoked_at=NOW()
  WHERE organization_id=v_target.organization_id AND LOWER(email)=LOWER(COALESCE(v_target.email,''))
    AND accepted_at IS NULL AND revoked_at IS NULL;

  RETURN jsonb_build_object('removed',TRUE,'user_id',v_target.user_id);
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