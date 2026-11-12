CREATE TABLE IF NOT EXISTS reviewers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'reviewer',
  specialty TEXT NOT NULL DEFAULT 'general',
  capacity INTEGER NOT NULL DEFAULT 8 CHECK (capacity BETWEEN 1 AND 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT UNIQUE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 180),
  description TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT 'General',
  queue TEXT NOT NULL DEFAULT 'General QA',
  task_type TEXT NOT NULL DEFAULT 'classification',
  priority SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','in_review','awaiting_approval','needs_revision','approved','rejected')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_to UUID REFERENCES reviewers(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL DEFAULT 'demo-seed',
  quality_score NUMERIC(5,2) CHECK (quality_score BETWEEN 0 AND 100),
  latest_verdict TEXT CHECK (latest_verdict IN ('pass','revise','fail')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_id UUID REFERENCES reviewers(id) ON DELETE SET NULL,
  rubric_version TEXT NOT NULL DEFAULT 'v1.0',
  attempt_number INTEGER NOT NULL DEFAULT 1,
  correctness NUMERIC(3,1) NOT NULL CHECK (correctness BETWEEN 1 AND 5),
  completeness NUMERIC(3,1) NOT NULL CHECK (completeness BETWEEN 1 AND 5),
  instruction_adherence NUMERIC(3,1) NOT NULL CHECK (instruction_adherence BETWEEN 1 AND 5),
  format_validity NUMERIC(3,1) NOT NULL CHECK (format_validity BETWEEN 1 AND 5),
  evidence_quality NUMERIC(3,1) NOT NULL CHECK (evidence_quality BETWEEN 1 AND 5),
  overall_score NUMERIC(5,2) NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','revise','fail')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS task_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name TEXT NOT NULL DEFAULT 'manual-import',
  submitted_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_status ON tasks(priority DESC, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_queue ON tasks(project, queue);
CREATE INDEX IF NOT EXISTS idx_reviews_task_created ON reviews(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_task_created ON task_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_created ON task_events(created_at DESC);