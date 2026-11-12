-- Milestone 4: scoped ingest credentials and asynchronous agent-trace storage.

CREATE TABLE IF NOT EXISTS integration_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '["traces:write"]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id,workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_integration_tokens_workspace
  ON integration_tokens(workspace_id,is_active,created_at DESC);

CREATE TABLE IF NOT EXISTS trace_ingest_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  token_id UUID NOT NULL,
  source TEXT NOT NULL DEFAULT 'otel-json',
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','completed','failed')),
  span_count INTEGER NOT NULL DEFAULT 0,
  stored_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  FOREIGN KEY (token_id,workspace_id)
    REFERENCES integration_tokens(id,workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_trace_batches_workspace
  ON trace_ingest_batches(workspace_id,received_at DESC);

CREATE INDEX IF NOT EXISTS idx_trace_batches_queue
  ON trace_ingest_batches(status,received_at);

CREATE TABLE IF NOT EXISTS agent_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT,
  status TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_ms NUMERIC(14,3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id,trace_id,span_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_workspace_created
  ON agent_traces(workspace_id,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_traces_workspace_trace
  ON agent_traces(workspace_id,trace_id,started_at);

CREATE INDEX IF NOT EXISTS idx_agent_traces_workspace_name
  ON agent_traces(workspace_id,name,created_at DESC);