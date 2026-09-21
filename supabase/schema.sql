-- ============================================================================
-- AEOD TECHNOLOGIES — Universal Client Onboarding & Discovery System
-- Supabase schema (Postgres) — v2.0 production
--
-- Run this once against a fresh Supabase project (SQL Editor, or `supabase db push`).
-- Everything here is additive/idempotent-ish (uses IF NOT EXISTS / CREATE OR REPLACE
-- where practical) so it is safe to re-run during setup.
--
-- NOTE: pgcrypto is already enabled in Supabase by default (in the `extensions`
-- schema), so we do NOT run `create extension pgcrypto` here — doing so throws
-- SQLSTATE 42710 (duplicate_object). gen_random_uuid() is also core in PG13+.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CLIENTS
-- ----------------------------------------------------------------------------
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  legal_name text,
  display_name text,
  organization_type text,               -- government, business, industrial, construction, agriculture, legal, nonprofit, executive, retail, technology, realestate, other
  legal_structure text,
  primary_location text,
  website text,
  created_at timestamptz not null default now(),
  status text not null default 'active' -- active | inactive | archived
);

-- ----------------------------------------------------------------------------
-- 2. CLIENT CONTACTS
-- ----------------------------------------------------------------------------
create table if not exists client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text,
  title text,
  email text,
  phone text,
  preferred_contact text,
  role_type text default 'primary',     -- primary | billing | technical | security | other
  created_at timestamptz not null default now()
);
create index if not exists idx_client_contacts_client on client_contacts(client_id);

-- ----------------------------------------------------------------------------
-- 3. ONBOARDING SUBMISSIONS (one intake attempt)
-- ----------------------------------------------------------------------------
create table if not exists onboarding_submissions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  status text not null default 'in_progress', -- in_progress | draft | submitted | reviewed | assigned | follow_up_required | archived
  schema_version text not null default 'AEOD_ONBOARDING_V2',
  current_step int default 1,
  started_at timestamptz not null default now(),
  last_saved_at timestamptz,
  submitted_at timestamptz,
  assigned_lead text,
  source text default 'web',
  metadata_json jsonb                    -- canonical full-payload snapshot (kept alongside structured tables, never *instead of* them)
);
create index if not exists idx_submissions_client on onboarding_submissions(client_id);
create index if not exists idx_submissions_status on onboarding_submissions(status);

-- ----------------------------------------------------------------------------
-- 4. ONBOARDING RESPONSES (structured, queryable key/value per section)
-- ----------------------------------------------------------------------------
create table if not exists onboarding_responses (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references onboarding_submissions(id) on delete cascade,
  section_key text not null,             -- contact | organization | challenge | readiness | governance | success | discovery
  field_key text not null,
  field_label text,
  value_json jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists idx_responses_submission on onboarding_responses(submission_id);
create index if not exists idx_responses_section on onboarding_responses(submission_id, section_key);

-- ----------------------------------------------------------------------------
-- 5. OPERATING SCHEDULES (7 rows per submission)
-- ----------------------------------------------------------------------------
create table if not exists operating_schedules (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references onboarding_submissions(id) on delete cascade,
  day_of_week text not null,             -- Monday..Sunday
  is_open boolean default false,
  opens_at time,
  closes_at time,
  timezone text,
  notes text
);
create index if not exists idx_schedules_submission on operating_schedules(submission_id);

-- ----------------------------------------------------------------------------
-- 6. DIGITAL PROFILES (one row per active social/digital channel)
-- ----------------------------------------------------------------------------
create table if not exists digital_profiles (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references onboarding_submissions(id) on delete cascade,
  platform text not null,                -- facebook, instagram, linkedin, x, tiktok, youtube, threads, pinterest, snapchat, nextdoor, other
  active boolean default true,
  profile_url text,
  manager text,
  notes text
);
create index if not exists idx_digital_submission on digital_profiles(submission_id);

-- ----------------------------------------------------------------------------
-- 7. DISCOVERY MODULES (versioned config — grows without redeploying the app)
-- ----------------------------------------------------------------------------
create table if not exists discovery_modules (
  id uuid primary key default gen_random_uuid(),
  module_key text unique not null,       -- government, industrial, construction, agriculture, legal, nonprofit, executive, retail, technology, realestate, business, other
  name text not null,
  sector text,
  active boolean default true,
  version int default 1,
  config_json jsonb                      -- field definitions for that module
);

-- ----------------------------------------------------------------------------
-- 8. SUBMISSION MODULES (which module(s) fired + their answers)
-- ----------------------------------------------------------------------------
create table if not exists submission_modules (
  submission_id uuid not null references onboarding_submissions(id) on delete cascade,
  module_key text not null,
  selected boolean default true,
  responses_json jsonb,
  primary key (submission_id, module_key)
);

-- ----------------------------------------------------------------------------
-- 9. ONBOARDING FILES
-- ----------------------------------------------------------------------------
create table if not exists onboarding_files (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references onboarding_submissions(id) on delete cascade,
  storage_path text not null,
  original_name text,
  mime_type text,
  size_bytes bigint,
  upload_status text not null default 'pending',  -- pending | uploaded | failed | verified
  scan_status text not null default 'unscanned',  -- unscanned | clean | quarantined | error
  created_at timestamptz not null default now()
);
create index if not exists idx_files_submission on onboarding_files(submission_id);

-- ----------------------------------------------------------------------------
-- 10. ONBOARDING EVENTS (full lifecycle audit trail)
-- ----------------------------------------------------------------------------
create table if not exists onboarding_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references onboarding_submissions(id) on delete cascade,
  event_type text not null,   -- started | draft | upload-authorized | file-uploaded | file-verified | submitted | reviewed | assigned | follow-up-required | archived | error
  actor_type text default 'client', -- client | system | staff
  actor_id text,
  event_at timestamptz not null default now(),
  details_json jsonb
);
create index if not exists idx_events_submission on onboarding_events(submission_id);

-- ----------------------------------------------------------------------------
-- 11. INTERNAL REVIEWS (Phase 4 — internal AEOD review interface)
-- ----------------------------------------------------------------------------
create table if not exists internal_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references onboarding_submissions(id) on delete cascade,
  reviewer_id text,
  status text default 'unassigned',  -- unassigned | in_review | needs_info | approved | follow_up
  priority text default 'normal',    -- low | normal | high | urgent
  notes text,
  next_action text,
  due_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_reviews_submission on internal_reviews(submission_id);

-- ============================================================================
-- ROW LEVEL SECURITY
--
-- Public "client submission" must NOT get broad DB access. All writes for the
-- public onboarding flow go through Netlify Functions using the SERVICE ROLE
-- key (server-side only, bypasses RLS). RLS below therefore denies anon and
-- authenticated roles entirely for the client tables. Add authenticated
-- staff-read policies in Phase 4 (internal review) as a separate, deliberate step.
-- ============================================================================
alter table clients enable row level security;
alter table client_contacts enable row level security;
alter table onboarding_submissions enable row level security;
alter table onboarding_responses enable row level security;
alter table operating_schedules enable row level security;
alter table digital_profiles enable row level security;
alter table discovery_modules enable row level security;
alter table submission_modules enable row level security;
alter table onboarding_files enable row level security;
alter table onboarding_events enable row level security;
alter table internal_reviews enable row level security;

-- No policies are created for anon/authenticated -> default-deny.
-- The service role used by Netlify Functions bypasses RLS automatically.

-- ============================================================================
-- PRIVATE STORAGE BUCKET
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('aeod-onboarding-documents', 'aeod-onboarding-documents', false)
on conflict (id) do nothing;

-- No storage.objects policies for anon/public — all access is via
-- service-role-issued signed upload URLs (write) and signed download
-- URLs (staff read), both minted server-side in Netlify Functions.

-- ============================================================================
-- SEED: discovery module registry (matches Section 8 sector list)
-- ============================================================================
insert into discovery_modules (module_key, name, sector, active, version, config_json) values
  ('government','Government / Public-Sector Discovery','Government / Municipal', true, 1, '{}'),
  ('industrial','Manufacturing / Industrial Discovery','Manufacturing / Industrial', true, 1, '{}'),
  ('construction','Construction / Field Operations Discovery','Construction / Field Ops', true, 1, '{}'),
  ('agriculture','Agriculture / Agribusiness Discovery','Agriculture', true, 1, '{}'),
  ('legal','Legal Services Discovery','Legal', true, 1, '{}'),
  ('nonprofit','Nonprofit / Association Discovery','Nonprofit / Board', true, 1, '{}'),
  ('executive','Executive / Leadership Discovery','Executive / Leadership', true, 1, '{}'),
  ('retail','Retail / Consumer Discovery','Retail / Consumer', true, 1, '{}'),
  ('technology','Technology / SaaS Discovery','Technology / SaaS', true, 1, '{}'),
  ('realestate','Real Estate / Development / Infrastructure Discovery','Real Estate / Infrastructure', true, 1, '{}'),
  ('business','Business Operations Discovery','Business', true, 1, '{}'),
  ('other','Hybrid / Other Discovery','Other', true, 1, '{}')
on conflict (module_key) do nothing;