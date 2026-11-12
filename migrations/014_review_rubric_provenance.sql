-- Milestone 5 foundation: bind every human review to the exact quality contract used.
-- Historical reviews are backfilled to the workspace's original default rubric.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rubric_id UUID;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rubric_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS submitted_by TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS submitted_by_email TEXT;

-- Reviews are append-only at runtime; temporarily lift the trigger for this one-time backfill.
DROP TRIGGER IF EXISTS reviews_append_only ON reviews;

UPDATE reviews rv
SET rubric_id = r.id,
    rubric_snapshot = jsonb_build_object(
      'id',r.id,
      'name',r.name,
      'version',r.version,
      'dimensions',r.dimensions,
      'pass_threshold',r.pass_threshold,
      'critical_floor',r.critical_floor
    )
FROM rubric_versions r
WHERE rv.rubric_id IS NULL
  AND r.workspace_id = rv.workspace_id
  AND r.name = 'TaskOps Default'
  AND r.version = 1;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_rubric_workspace_fkey
  FOREIGN KEY (rubric_id,workspace_id)
  REFERENCES rubric_versions(id,workspace_id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_reviews_workspace_rubric
  ON reviews(workspace_id,rubric_id,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reviews_workspace_submitted_by
  ON reviews(workspace_id,submitted_by,created_at DESC);

CREATE TRIGGER reviews_append_only
BEFORE UPDATE OR DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION taskops_block_audit_mutation();