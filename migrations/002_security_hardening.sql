-- Milestone 0: protect the existing single-workspace demo before adding real data.
-- This migration is additive: it preserves all existing tasks, reviewers, reviews and events.

CREATE OR REPLACE FUNCTION taskops_block_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'audit_records_are_append_only';
END;
$$;

DROP TRIGGER IF EXISTS task_events_append_only ON task_events;
CREATE TRIGGER task_events_append_only
BEFORE UPDATE OR DELETE ON task_events
FOR EACH ROW EXECUTE FUNCTION taskops_block_audit_mutation();

DROP TRIGGER IF EXISTS reviews_append_only ON reviews;
CREATE TRIGGER reviews_append_only
BEFORE UPDATE OR DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION taskops_block_audit_mutation();

-- Capacity-safe assignment: serialize attempts for a reviewer, then check
-- capacity and task state while holding the relevant locks. The event and
-- task mutation are part of the same PostgreSQL function transaction.
CREATE OR REPLACE FUNCTION taskops_assign_task(
  p_task_id uuid,
  p_reviewer_id uuid,
  p_actor text
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
  IF p_task_id IS NULL OR p_reviewer_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'task_and_reviewer_required';
  END IF;

  -- All assignments to the same reviewer take this lock before checking load.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_reviewer_id::text, 0));

  SELECT * INTO v_reviewer
  FROM reviewers
  WHERE id = p_reviewer_id AND active = TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'reviewer_not_found';
  END IF;

  SELECT COUNT(*)::integer INTO v_open_count
  FROM tasks
  WHERE assigned_to = p_reviewer_id
    AND status IN ('in_review', 'needs_revision', 'awaiting_approval')
    AND id <> p_task_id;

  IF v_open_count >= v_reviewer.capacity THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reviewer_at_capacity';
  END IF;

  SELECT * INTO v_task
  FROM tasks
  WHERE id = p_task_id
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
  WHERE id = p_task_id
  RETURNING * INTO v_task;

  INSERT INTO task_events (
    task_id, actor, action, from_status, to_status, metadata
  ) VALUES (
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