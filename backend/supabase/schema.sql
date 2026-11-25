-- NOSIH — Supabase schema (certificate authentication platform)
-- Fresh installs: run this once in the Supabase SQL editor. Safe to re-run.
-- EXISTING NOSIH installs: run migrations/001_nosih.sql instead —
-- it adds these tables additively and preserves the land-registry data.

-- ── Users (platform admins / institution admins / issuers / auditors) ──
create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  email             text not null unique,
  password_hash     text not null,              -- bcrypt, 12 rounds
  role              text not null default 'issuer'
    check (role in ('admin', 'platform_admin', 'institution_admin', 'issuer', 'auditor')),
  wallet_address    text,
  organization_name text,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── Institutions ─────────────────────────────────────────
create table if not exists institutions (
  id                  uuid primary key default gen_random_uuid(),
  institution_id      text not null unique,          -- INST-XXXXXXXX (random)
  institution_id_hash char(66) not null unique,      -- HMAC(HASH_PEPPER, "institution|INST-…") — the on-chain value
  name                text not null,
  legal_name          text,
  registration_number text not null unique,
  website             text,
  address             text,
  wallet_config       jsonb not null default '{}'::jsonb,
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'approved', 'rejected', 'suspended')),
  status_reason       text,
  approved_by         uuid references users(id),
  approved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table users add column if not exists institution_id uuid references institutions(id);

create index if not exists institutions_status_idx      on institutions (verification_status);
create index if not exists institutions_created_at_idx  on institutions (created_at desc);
create index if not exists users_institution_id_idx     on users (institution_id);
create index if not exists users_role_idx               on users (role);

-- ── Issuer wallets (one wallet ↔ one institution, mirrors the contract) ──
create table if not exists issuer_wallets (
  id                    uuid primary key default gen_random_uuid(),
  institution_id        uuid not null references institutions(id),
  wallet_address        text not null unique
    check (wallet_address ~ '^0x[0-9a-f]{40}$'),     -- stored lowercase
  active                boolean not null default true,
  authorized_by         uuid references users(id),
  authorization_tx_hash text,
  created_at            timestamptz not null default now()
);

create index if not exists issuer_wallets_institution_idx on issuer_wallets (institution_id);
create index if not exists issuer_wallets_active_idx      on issuer_wallets (active);

-- ── Certificates (authoritative rows — only after chain confirmation) ──
create table if not exists certificates (
  id                        uuid primary key default gen_random_uuid(),
  certificate_id            text not null unique,    -- CERT-XXXXXXXX (random, never PII-derived)
  certificate_id_hash       char(66) not null unique,

  institution_id            uuid not null references institutions(id),
  institution_id_hash       char(66) not null,
  issuer_user_id            uuid references users(id),
  issuer_wallet             text not null,

  holder_name               text not null,
  holder_identity_hash      char(66) not null,
  holder_identifier         text,

  certificate_type          text not null,
  certificate_number        text,
  course_name               text,
  qualification             text,
  qualification_level       text,
  specialization            text,
  grade                     text,
  percentage                text,
  issue_date                date,
  expiry_date               date,
  academic_year             text,
  signatory_name            text,
  signatory_designation     text,
  extra_data                jsonb not null default '{}'::jsonb,

  document_hash             char(66) not null unique,
  metadata_hash             char(66) not null,
  ipfs_cid                  text not null,           -- CID of the ENCRYPTED PDF
  encryption_iv             text not null,
  encryption_tag            text not null,
  original_filename         text,

  tx_hash                   text,
  block_number              bigint,
  issued_at                 timestamptz,
  chain_expires_at          bigint not null default 0,

  status                    text not null default 'active'
    check (status in ('active', 'revoked', 'expired', 'superseded')),
  supersedes_certificate_id text references certificates(certificate_id),
  superseded_by_certificate_id text,
  revoked_at                timestamptz,
  revoke_reason             text,
  revoked_tx_hash           text,

  qr_code_data              text,
  verify_url                text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create unique index if not exists certificates_inst_number_uniq
  on certificates (institution_id, certificate_number)
  where certificate_number is not null and certificate_number <> '';

create index if not exists certificates_institution_idx on certificates (institution_id);
create index if not exists certificates_wallet_idx      on certificates (issuer_wallet);
create index if not exists certificates_status_idx      on certificates (status);
create index if not exists certificates_type_idx        on certificates (certificate_type);
create index if not exists certificates_created_at_idx  on certificates (created_at desc);

-- ── Issuance intents (prepare → sign → confirm; NOT public certificates) ──
create table if not exists issuance_intents (
  id                  uuid primary key default gen_random_uuid(),
  certificate_id      text not null unique,
  certificate_id_hash char(66) not null unique,
  institution_id      uuid not null references institutions(id),
  institution_id_hash char(66) not null,
  issuer_user_id      uuid references users(id),
  issuer_wallet       text not null,

  certificate_payload jsonb not null,
  document_hash       char(66) not null,
  metadata_hash       char(66) not null,
  holder_identity_hash char(66) not null,
  ipfs_cid            text not null,
  encryption_iv       text not null,
  encryption_tag      text not null,
  original_filename   text,
  supersedes_certificate_id text,
  chain_expires_at    bigint not null default 0,

  status              text not null default 'prepared'
    check (status in ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  tx_hash             text,
  block_number        bigint,
  failure_reason      text,
  expires_at          timestamptz not null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists issuance_intents_institution_idx on issuance_intents (institution_id);
create index if not exists issuance_intents_status_idx      on issuance_intents (status);
create index if not exists issuance_intents_doc_hash_idx    on issuance_intents (document_hash);
create index if not exists issuance_intents_expires_idx     on issuance_intents (expires_at);
create index if not exists issuance_intents_created_at_idx  on issuance_intents (created_at desc);

-- ── Certificate events (audit trail) ─────────────────────
create table if not exists certificate_events (
  id               uuid primary key default gen_random_uuid(),
  certificate_id   text not null references certificates(certificate_id),
  event_type       text not null
    check (event_type in ('issued', 'verified', 'revoked', 'reissued', 'expired', 'superseded')),
  performed_by     uuid references users(id),        -- null for public verifications
  institution_id   uuid references institutions(id),
  reason           text,
  transaction_hash text,
  previous_status  text,
  new_status       text,
  details          jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists certificate_events_cert_idx        on certificate_events (certificate_id);
create index if not exists certificate_events_type_idx        on certificate_events (event_type);
create index if not exists certificate_events_institution_idx on certificate_events (institution_id);
create index if not exists certificate_events_created_at_idx  on certificate_events (created_at desc);

-- ── updated_at maintenance ────────────────────────────────
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at
  before update on users for each row execute function set_updated_at();

drop trigger if exists institutions_set_updated_at on institutions;
create trigger institutions_set_updated_at
  before update on institutions for each row execute function set_updated_at();

drop trigger if exists certificates_set_updated_at on certificates;
create trigger certificates_set_updated_at
  before update on certificates for each row execute function set_updated_at();

drop trigger if exists issuance_intents_set_updated_at on issuance_intents;
create trigger issuance_intents_set_updated_at
  before update on issuance_intents for each row execute function set_updated_at();

-- ── Defense in depth ──────────────────────────────────────
-- Backend uses the service-role key (bypasses RLS). With RLS on and no
-- policies, the anon/publishable key can never read these tables.
alter table users              enable row level security;
alter table institutions       enable row level security;
alter table issuer_wallets     enable row level security;
alter table certificates       enable row level security;
alter table issuance_intents   enable row level security;
alter table certificate_events enable row level security;