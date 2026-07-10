create extension if not exists "pgcrypto";

create table if not exists templates (
  id text primary key,
  name text not null,
  version integer not null default 1,
  template_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists template_regions (
  id uuid primary key default gen_random_uuid(),
  template_id text not null references templates (id) on delete cascade,
  region_type text not null,
  question_no integer,
  choice_label text,
  x numeric not null,
  y numeric not null,
  w numeric not null,
  h numeric not null
);

create table if not exists scan_sessions (
  id uuid primary key default gen_random_uuid(),
  template_id text not null references templates (id) on delete cascade,
  uploader text,
  source_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists scan_results (
  id uuid primary key default gen_random_uuid(),
  scan_session_id uuid not null references scan_sessions (id) on delete cascade,
  template_id text not null references templates (id) on delete cascade,
  source_name text not null,
  result_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_scan_results_created_at on scan_results (created_at desc);
create index if not exists idx_scan_sessions_created_at on scan_sessions (created_at desc);
