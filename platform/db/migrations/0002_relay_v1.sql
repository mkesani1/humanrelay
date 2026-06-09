-- Relay v1: negotiation, pattern library, cache auditing

alter table relay_traces add column if not exists clarification_question text;
alter table relay_traces add column if not exists clarification_answer text;
alter table relay_traces drop constraint if exists relay_traces_status_check;
alter table relay_traces add constraint relay_traces_status_check check (status in
  ('planning','needs_clarification','running','reassembling','completed','failed','over_budget'));

create table if not exists relay_patterns (
  id uuid primary key default gen_random_uuid(),
  question_norm text not null,
  question_hash text not null unique,
  embedding jsonb not null,
  plan jsonb not null,            -- binary templates with {{question}} placeholder
  uses integer not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

alter table binary_cache add column if not exists uses integer not null default 0;
alter table binary_cache add column if not exists audit_mismatches integer not null default 0;
