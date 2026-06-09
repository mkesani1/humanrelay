-- HumanRelay platform — core schema
-- Conventions: text + CHECK instead of enums (cheap to evolve), timestamptz everywhere,
-- append-only task_events as the audit trail (the audit trail is the product).

create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- signing secret for per-task webhook URLs (org-registered webhooks carry their own)
  webhook_secret text not null default ('whsec_' || md5(random()::text || clock_timestamp()::text)),
  created_at timestamptz not null default now()
);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  key_hash text not null unique,          -- sha256 of full key; raw key shown once
  prefix text not null,                   -- hr_live_xxxx for display
  rate_limit_per_min integer not null default 600,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists api_keys_org_idx on api_keys(org_id);

create table if not exists workers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  tier text not null check (tier in ('basic','complex','expert')),
  skills text[] not null default '{}',
  active boolean not null default true,
  -- Beta posterior over accuracy, updated by gold-set results
  gold_alpha double precision not null default 1,
  gold_beta double precision not null default 1,
  tasks_since_gold integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  idempotency_key text,
  primitive text not null check (primitive in ('classify','judge','extract','escalate','resolve','safety_confirm','annotate')),
  tier text not null check (tier in ('basic','complex','expert')),
  status text not null default 'pending' check (status in
    ('pending','assigned','answered','completed','failed','expired','canceled')),
  payload jsonb not null default '{}',
  rubric text,
  skill_tags text[] not null default '{}',
  consensus_n integer not null default 1,
  price_cents integer not null,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  is_gold boolean not null default false,
  gold_expected jsonb,
  parent_kind text check (parent_kind in ('relay','teleop','dataset')),
  parent_id uuid,
  relay_binary_id text,                   -- id of the binary within the relay plan
  result jsonb,
  rationale text,
  sla_seconds integer not null default 300,
  webhook_url text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (org_id, idempotency_key)
);
create index if not exists tasks_org_status_idx on tasks(org_id, status);
create index if not exists tasks_parent_idx on tasks(parent_kind, parent_id);
create index if not exists tasks_pending_idx on tasks(status) where status = 'pending';

create table if not exists task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references tasks(id),
  type text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists task_events_task_idx on task_events(task_id);

create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  worker_id uuid not null references workers(id),
  status text not null default 'active' check (status in ('active','completed','expired','released')),
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists assignments_task_idx on assignments(task_id);
create index if not exists assignments_active_idx on assignments(worker_id) where status = 'active';

create table if not exists answers (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  assignment_id uuid not null references assignments(id),
  worker_id uuid not null references workers(id),
  verdict jsonb not null,
  rationale text,
  gold_correct boolean,                   -- set when the task was a gold item
  created_at timestamptz not null default now()
);
create index if not exists answers_task_idx on answers(task_id);

create table if not exists gold_items (
  id uuid primary key default gen_random_uuid(),
  primitive text not null,
  tier text not null,
  payload jsonb not null,
  rubric text,
  expected jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists webhooks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  url text not null,
  secret text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  url text not null,
  secret text not null,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','delivered','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists webhook_deliveries_due_idx on webhook_deliveries(next_attempt_at) where status = 'pending';

create table if not exists usage_meters (
  org_id uuid not null references orgs(id),
  period text not null,                   -- 'YYYY-MM'
  primitive text not null,
  tier text not null,
  calls integer not null default 0,
  amount_cents integer not null default 0,
  primary key (org_id, period, primitive, tier)
);

-- ===== Relay =====

create table if not exists relay_traces (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  question text not null,
  tier_cap text not null default 'expert',
  max_cost_cents integer,
  strategy text,                          -- 'direct' | 'decompose' | 'cache'
  status text not null default 'planning' check (status in
    ('planning','running','reassembling','completed','failed','over_budget')),
  plan jsonb,
  verdict jsonb,
  rationale text,
  total_cost_cents integer not null default 0,
  cache_hits integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists binary_cache (
  id uuid primary key default gen_random_uuid(),
  question_norm text not null,
  question_hash text not null unique,
  embedding jsonb not null,               -- deterministic feature vector (pluggable provider)
  tier text not null,
  verdict jsonb not null,
  consensus_count integer not null default 1,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists binary_cache_norm_idx on binary_cache(question_norm);

-- ===== Capture =====

create table if not exists capture_clips (
  id uuid primary key default gen_random_uuid(),
  center text not null,
  collector_code text not null,           -- pseudonymized collector id
  task_label text not null,
  taxonomy text[] not null default '{}',
  duration_s integer not null,
  resolution text not null default '4K',
  fps integer not null default 30,
  streams text[] not null default '{video,audio,imu}',
  consent_id text not null,
  pii_scrubbed boolean not null default false,
  storage_url text not null,
  status text not null default 'ingested' check (status in ('ingested','processed','qc_passed','qc_failed','published')),
  recorded_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists capture_clips_status_idx on capture_clips(status);

create table if not exists datasets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  name text not null,
  filter jsonb not null default '{}',
  clip_count integer not null default 0,
  total_hours double precision not null default 0,
  manifest jsonb,
  status text not null default 'building' check (status in ('building','ready','delivered')),
  created_at timestamptz not null default now()
);

-- ===== Teleop =====

create table if not exists teleop_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  robot_id text not null,
  context jsonb not null default '{}',
  control_scope jsonb not null default '{}',
  status text not null default 'requested' check (status in
    ('requested','safety_check','denied','active','handback','completed','failed')),
  safety_task_id uuid references tasks(id),
  operator_id uuid references workers(id),
  recording_url text,
  demonstration_task_id uuid references tasks(id),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);
create index if not exists teleop_sessions_org_idx on teleop_sessions(org_id, status);
