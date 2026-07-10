create extension if not exists "pgcrypto";

create table if not exists templates (
  id text primary key,
  name text not null,
  version integer not null default 1,
  template_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists scan_results (
  id uuid primary key default gen_random_uuid(),
  template_id text not null references templates (id) on delete cascade,
  source_name text not null,
  result_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_scan_results_created_at on scan_results (created_at desc);
