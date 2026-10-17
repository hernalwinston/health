-- =====================================================================
--  DR. MENDOZA MULTI-SPECIALTY CLINIC
--  Clinic Management System - Supabase schema
--  Run this whole file in: Supabase Dashboard -> SQL Editor -> Run
-- =====================================================================
--
--  Login (seeded automatically):
--    Admin     -> username: admin      password: admin123
--    Employee  -> username: employee   password: employee123
--
--  Access is done ONLY through SECURITY DEFINER functions (below).
--  Tables have Row Level Security enabled with no policies, so the
--  publishable (anon) key cannot read or write tables directly.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. SETUP  (this whole script is idempotent / safe to re-run)
-- ---------------------------------------------------------------------
-- Everything below runs in ONE transaction, so if anything fails the
-- database is left exactly as it was (no half-applied schema).
begin;
-- Hides harmless "function ... does not exist, skipping" notices from DROPs.
set client_min_messages = warning;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- Make crypt()/gen_salt() resolvable no matter where pgcrypto lives.
set search_path = public, extensions;

-- Drop the app's RPCs up front. This guarantees a clean re-run: a changed
-- argument list or return type can never trigger
-- "cannot change return type of existing function" or stale-overload
-- errors. No table data is ever touched by these drops.
drop function if exists public.login(text, text);
drop function if exists public.heartbeat(uuid);
drop function if exists public.logout(uuid);
drop function if exists public.list_employees(uuid);
drop function if exists public.create_employee(uuid, text, text, text, text);
drop function if exists public.update_employee(uuid, uuid, text, text, text);
drop function if exists public.set_employee_active(uuid, uuid, boolean);
drop function if exists public.delete_employee(uuid, uuid);
drop function if exists public.set_archived(uuid, text, uuid, boolean);
drop function if exists public.list_archived(uuid);
drop function if exists public.delete_archived(uuid, text, uuid);
drop function if exists public.list_services(uuid);
drop function if exists public.upsert_service(uuid, uuid, text, text, numeric);
drop function if exists public.create_patient(uuid, text, integer, text, text, text, text);
drop function if exists public.update_patient(uuid, uuid, text, integer, text, text, text, text);
drop function if exists public.search_patients(uuid, text);
drop function if exists public.get_patient_record(uuid, uuid);
drop function if exists public.create_visit(uuid, uuid, jsonb);
drop function if exists public.record_payment(uuid, uuid, text, numeric);
drop function if exists public.start_lab(uuid, uuid);
drop function if exists public.complete_visit(uuid, uuid);
drop function if exists public.refund_visit(uuid, uuid, text);
drop function if exists public.list_visits(uuid, text);
drop function if exists public.get_stats(uuid);
drop function if exists public.get_charts(uuid);
drop function if exists public.get_report(uuid, text, date, date);
drop function if exists public.fn_log(uuid, text, text);
drop function if exists public.list_activity(uuid, integer);          -- legacy overload
drop function if exists public.list_activity(uuid, integer, date, date);
drop function if exists public.list_receipts(uuid, text);
drop function if exists public.save_receipt_file(uuid, uuid, text, text, text);
drop function if exists public.get_receipt_file(uuid, uuid);
-- helpers last (callers above are already gone)
drop function if exists public.fn_is_admin(uuid);
drop function if exists public.fn_actor(uuid);

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

create table if not exists public.employees (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  full_name     text not null default '',
  role          text not null default 'employee' check (role in ('admin','employee')),
  password_hash text not null,
  is_active     boolean not null default true,
  last_seen     timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.services (
  id         uuid primary key default gen_random_uuid(),
  category   text not null default 'Other',
  name       text not null,
  price      numeric(12,2) not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (category, name)
);

create table if not exists public.patients (
  id            uuid primary key default gen_random_uuid(),
  patient_no    text not null unique,
  full_name     text not null,
  age           integer,
  gender        text,
  address       text,
  contact       text,
  referred_by   text,
  registered_by uuid references public.employees(id) on delete set null,
  registered_at timestamptz not null default now(),
  archived_at   timestamptz
);

create sequence if not exists public.patient_seq start 1;

create table if not exists public.visits (
  id           uuid primary key default gen_random_uuid(),
  visit_no     text not null unique,
  patient_id   uuid not null references public.patients(id) on delete cascade,
  status       text not null default 'pending_payment'
                 check (status in ('pending_payment','paid','in_lab','completed','refunded','cancelled')),
  total        numeric(12,2) not null default 0,
  notes        text,
  created_by   uuid references public.employees(id) on delete set null,
  created_at   timestamptz not null default now(),
  paid_at      timestamptz,
  lab_at       timestamptz,
  completed_at timestamptz,
  refunded_at  timestamptz,
  archived_at  timestamptz
);

create sequence if not exists public.visit_seq start 1;

create table if not exists public.visit_items (
  id         uuid primary key default gen_random_uuid(),
  visit_id   uuid not null references public.visits(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  name       text not null,
  price      numeric(12,2) not null default 0
);

create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  visit_id    uuid not null references public.visits(id) on delete cascade,
  amount      numeric(12,2) not null default 0,
  method      text not null default 'Cash',
  status      text not null default 'paid' check (status in ('paid','refunded')),
  note        text,
  received_by uuid references public.employees(id) on delete set null,
  paid_at     timestamptz not null default now()
);

-- Safety net: guarantee every expected column exists even if these tables
-- were created by an older version of this file. On an up-to-date database
-- each line is a no-op, so it can never error out.
alter table public.employees add column if not exists username      text;
alter table public.employees add column if not exists full_name     text default '';
alter table public.employees add column if not exists role          text default 'employee';
alter table public.employees add column if not exists password_hash text;
alter table public.employees add column if not exists is_active     boolean default true;
alter table public.employees add column if not exists last_seen     timestamptz;
alter table public.employees add column if not exists created_at    timestamptz default now();

alter table public.services add column if not exists category   text default 'Other';
alter table public.services add column if not exists name       text;
alter table public.services add column if not exists price      numeric(12,2) default 0;
alter table public.services add column if not exists is_active  boolean default true;
alter table public.services add column if not exists created_at timestamptz default now();

alter table public.patients add column if not exists patient_no    text;
alter table public.patients add column if not exists full_name     text;
alter table public.patients add column if not exists age           integer;
alter table public.patients add column if not exists gender        text;
alter table public.patients add column if not exists address       text;
alter table public.patients add column if not exists contact       text;
alter table public.patients add column if not exists referred_by   text;
alter table public.patients add column if not exists registered_by uuid;
alter table public.patients add column if not exists registered_at timestamptz default now();
alter table public.patients add column if not exists archived_at   timestamptz;

alter table public.visits add column if not exists visit_no     text;
alter table public.visits add column if not exists patient_id   uuid;
alter table public.visits add column if not exists status       text default 'pending_payment';
alter table public.visits add column if not exists total        numeric(12,2) default 0;
alter table public.visits add column if not exists notes        text;
alter table public.visits add column if not exists created_by   uuid;
alter table public.visits add column if not exists created_at   timestamptz default now();
alter table public.visits add column if not exists paid_at      timestamptz;
alter table public.visits add column if not exists lab_at       timestamptz;
alter table public.visits add column if not exists completed_at timestamptz;
alter table public.visits add column if not exists refunded_at  timestamptz;
alter table public.visits add column if not exists archived_at  timestamptz;

alter table public.visit_items add column if not exists visit_id   uuid;
alter table public.visit_items add column if not exists service_id uuid;
alter table public.visit_items add column if not exists name       text;
alter table public.visit_items add column if not exists price      numeric(12,2) default 0;

alter table public.payments add column if not exists visit_id    uuid;
alter table public.payments add column if not exists amount      numeric(12,2) default 0;
alter table public.payments add column if not exists method      text default 'Cash';
alter table public.payments add column if not exists status      text default 'paid';
alter table public.payments add column if not exists note        text;
alter table public.payments add column if not exists received_by uuid;
alter table public.payments add column if not exists paid_at     timestamptz default now();

create index if not exists idx_patients_name   on public.patients (lower(full_name));
create index if not exists idx_patients_no     on public.patients (patient_no);
create index if not exists idx_visits_patient  on public.visits (patient_id);
create index if not exists idx_visits_status   on public.visits (status);
create index if not exists idx_payments_visit  on public.payments (visit_id);
create index if not exists idx_items_visit     on public.visit_items (visit_id);

alter table public.employees   enable row level security;
alter table public.services    enable row level security;
alter table public.patients    enable row level security;
alter table public.visits      enable row level security;
alter table public.visit_items enable row level security;
alter table public.payments    enable row level security;

-- ---------------------------------------------------------------------
-- 2. HELPERS
-- ---------------------------------------------------------------------

create or replace function public.fn_actor(p_actor uuid)
returns public.employees
language sql security definer set search_path = public, extensions as $$
  select e.* from public.employees e where e.id = p_actor and e.is_active = true;
$$;

create or replace function public.fn_is_admin(p_actor uuid)
returns boolean
language sql security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.employees
    where id = p_actor and role = 'admin' and is_active = true
  );
$$;

-- ---------------------------------------------------------------------
-- 3. AUTH / SESSION RPCs
-- ---------------------------------------------------------------------

create or replace function public.login(p_username text, p_password text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v public.employees;
begin
  select * into v from public.employees where lower(username) = lower(trim(p_username)) limit 1;
  if not found then
    raise exception 'Invalid username or password.';
  end if;
  if v.password_hash is null or crypt(p_password, v.password_hash) <> v.password_hash then
    raise exception 'Invalid username or password.';
  end if;
  if not v.is_active then
    raise exception 'This account is not active. Please contact the administrator.';
  end if;
  update public.employees set last_seen = now() where id = v.id;
  return json_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role
  );
end; $$;

-- Keeps the account marked "Active" while the app is open.
create or replace function public.heartbeat(p_actor uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.employees set last_seen = now() where id = p_actor and is_active = true;
end; $$;

create or replace function public.logout(p_actor uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.employees
     set last_seen = now() - interval '1 day'
   where id = p_actor;
end; $$;

-- ---------------------------------------------------------------------
-- 4. EMPLOYEE MANAGEMENT (admin only)
-- ---------------------------------------------------------------------

-- Admin only: list employees with computed online status.
create or replace function public.list_employees(p_actor uuid)
returns table (
  id uuid, username text, full_name text, role text,
  is_active boolean, last_seen timestamptz, created_at timestamptz,
  is_online boolean
)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can view employees.';
  end if;
  return query
    select e.id, e.username, e.full_name, e.role, e.is_active, e.last_seen, e.created_at,
           (e.last_seen is not null and e.last_seen > now() - interval '2 minutes') as is_online
      from public.employees e
     order by e.role desc, e.created_at asc;
end; $$;

create or replace function public.create_employee(
  p_actor uuid, p_username text, p_password text, p_full_name text, p_role text default 'employee'
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can create accounts.';
  end if;
  if length(trim(coalesce(p_username,''))) < 3 then
    raise exception 'Username must be at least 3 characters.';
  end if;
  if length(coalesce(p_password,'')) < 4 then
    raise exception 'Password must be at least 4 characters.';
  end if;
  if exists (select 1 from public.employees where lower(username) = lower(trim(p_username))) then
    raise exception 'That username is already taken.';
  end if;
  if p_role not in ('admin','employee') then
    raise exception 'Invalid role.';
  end if;
  insert into public.employees (username, full_name, role, password_hash)
  values (lower(trim(p_username)), trim(p_full_name), p_role, crypt(p_password, gen_salt('bf')))
  returning id into v_id;
  return json_build_object('id', v_id);
end; $$;

create or replace function public.update_employee(
  p_actor uuid, p_id uuid, p_full_name text, p_role text, p_password text default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can modify accounts.';
  end if;
  update public.employees
     set full_name = trim(p_full_name),
         role = case when p_role in ('admin','employee') then p_role else role end,
         password_hash = case
           when p_password is not null and length(p_password) >= 4
             then crypt(p_password, gen_salt('bf'))
           else password_hash end
   where id = p_id;
end; $$;

create or replace function public.set_employee_active(p_actor uuid, p_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can enable or disable accounts.';
  end if;
  if p_id = p_actor and p_active = false then
    raise exception 'You cannot disable your own account.';
  end if;
  update public.employees set is_active = p_active where id = p_id;
end; $$;

-- ---------------------------------------------------------------------
-- 5. SERVICES (catalog)
-- ---------------------------------------------------------------------

create or replace function public.list_services(p_actor uuid)
returns setof public.services
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  return query select s.* from public.services s where s.is_active = true order by s.category, s.name;
end; $$;

create or replace function public.upsert_service(
  p_actor uuid, p_id uuid, p_category text, p_name text, p_price numeric
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can manage services.';
  end if;
  if p_id is null then
    insert into public.services (category, name, price)
    values (trim(p_category), trim(p_name), coalesce(p_price,0))
    returning id into v_id;
  else
    update public.services
       set category = trim(p_category), name = trim(p_name), price = coalesce(p_price,0)
     where id = p_id
     returning id into v_id;
  end if;
  return json_build_object('id', v_id);
end; $$;

-- ---------------------------------------------------------------------
-- 6. PATIENTS
-- ---------------------------------------------------------------------

create or replace function public.create_patient(
  p_actor uuid, p_full_name text, p_age integer, p_gender text,
  p_address text, p_contact text, p_referred_by text
) returns public.patients
language plpgsql security definer set search_path = public, extensions as $$
declare v public.patients;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  if length(trim(coalesce(p_full_name,''))) < 2 then
    raise exception 'Patient name is required.';
  end if;
  insert into public.patients (patient_no, full_name, age, gender, address, contact, referred_by, registered_by)
  values (
    'P-' || lpad(nextval('public.patient_seq')::text, 5, '0'),
    trim(p_full_name), p_age, p_gender, trim(p_address), trim(p_contact), trim(p_referred_by), p_actor
  )
  returning * into v;
  return v;
end; $$;

create or replace function public.search_patients(p_actor uuid, p_query text default '')
returns setof public.patients
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  return query
    select pt.* from public.patients pt
     where pt.archived_at is null
       and (p_query = ''
        or lower(pt.full_name) like '%' || lower(p_query) || '%'
        or lower(pt.patient_no) like '%' || lower(p_query) || '%'
        or lower(coalesce(pt.address,'')) like '%' || lower(p_query) || '%'
        or lower(coalesce(pt.referred_by,'')) like '%' || lower(p_query) || '%')
     order by pt.registered_at desc
     limit 200;
end; $$;

-- Full record for a patient: visits, items and payments.
create or replace function public.get_patient_record(p_actor uuid, p_patient_id uuid)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_patient public.patients; v_visits json;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  select * into v_patient from public.patients where id = p_patient_id;
  if not found then raise exception 'Patient not found.'; end if;

  select coalesce(json_agg(row_to_json(t) order by t.created_at desc), '[]'::json) into v_visits
  from (
    select vi.*,
      (select coalesce(json_agg(row_to_json(ii) order by ii.name), '[]'::json)
         from public.visit_items ii where ii.visit_id = vi.id) as items,
      (select coalesce(json_agg(row_to_json(pp) order by pp.paid_at), '[]'::json)
         from public.payments pp where pp.visit_id = vi.id) as payments
    from public.visits vi
    where vi.patient_id = p_patient_id
  ) t;

  return json_build_object('patient', row_to_json(v_patient), 'visits', v_visits);
end; $$;

-- ---------------------------------------------------------------------
-- 7. VISITS + PAYMENT / LAB FLOW
-- ---------------------------------------------------------------------

-- Create a visit with chosen services. items jsonb = [{service_id, price}]
create or replace function public.create_visit(p_actor uuid, p_patient_id uuid, p_items jsonb)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_visit public.visits; v_total numeric(12,2) := 0; it jsonb;
        v_admin boolean; v_price numeric; v_cat numeric; v_srv_id uuid; v_name text;
        v_fixed jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Please select at least one service.';
  end if;

  v_admin := public.fn_is_admin(p_actor);

  -- Prices always come from the catalog. Only the administrator may override them.
  for it in select * from jsonb_array_elements(p_items) loop
    v_srv_id := nullif(it->>'service_id','')::uuid;
    v_name   := coalesce(it->>'name','Service');
    v_price  := coalesce((it->>'price')::numeric, 0);
    if not v_admin and v_srv_id is not null then
      v_cat := null;
      select s.price, s.name into v_cat, v_name from public.services s where s.id = v_srv_id;
      if v_cat is not null then v_price := v_cat; end if;
      if v_name is null then v_name := coalesce(it->>'name','Service'); end if;
    end if;
    v_total := v_total + v_price;
    v_fixed := v_fixed || jsonb_build_array(
      jsonb_build_object('service_id', v_srv_id, 'name', v_name, 'price', v_price));
  end loop;

  insert into public.visits (visit_no, patient_id, status, total, created_by)
  values ('V-' || lpad(nextval('public.visit_seq')::text, 5, '0'), p_patient_id, 'pending_payment', v_total, p_actor)
  returning * into v_visit;

  for it in select * from jsonb_array_elements(v_fixed) loop
    insert into public.visit_items (visit_id, service_id, name, price)
    values (
      v_visit.id,
      nullif(it->>'service_id','')::uuid,
      coalesce(it->>'name','Service'),
      coalesce((it->>'price')::numeric, 0)
    );
  end loop;

  return json_build_object('id', v_visit.id, 'visit_no', v_visit.visit_no, 'total', v_visit.total, 'status', v_visit.status);
end; $$;

create or replace function public.record_payment(p_actor uuid, p_visit_id uuid, p_method text, p_amount numeric)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v public.visits;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  select * into v from public.visits where id = p_visit_id;
  if not found then raise exception 'Visit not found.'; end if;
  if v.status in ('paid','in_lab','completed') then
    raise exception 'This visit is already paid.';
  end if;
  if v.status = 'refunded' then
    raise exception 'This visit was refunded.';
  end if;
  insert into public.payments (visit_id, amount, method, status, received_by)
  values (p_visit_id, coalesce(p_amount, v.total), coalesce(p_method,'Cash'), 'paid', p_actor);
  update public.visits set status = 'paid', paid_at = now() where id = p_visit_id;
  return json_build_object('status','paid');
end; $$;

-- Only a PAID visit may enter the laboratory.
create or replace function public.start_lab(p_actor uuid, p_visit_id uuid)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v public.visits;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  select * into v from public.visits where id = p_visit_id;
  if not found then raise exception 'Visit not found.'; end if;
  if v.status = 'pending_payment' then
    raise exception 'Payment is required before proceeding to the laboratory.';
  end if;
  if v.status = 'refunded' then
    raise exception 'This visit was refunded and cannot proceed.';
  end if;
  update public.visits set status = 'in_lab', lab_at = now() where id = p_visit_id;
  return json_build_object('status','in_lab');
end; $$;

create or replace function public.complete_visit(p_actor uuid, p_visit_id uuid)
returns json
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  update public.visits set status = 'completed', completed_at = now()
   where id = p_visit_id and status in ('paid','in_lab');
  if not found then raise exception 'Only a paid or in-lab visit can be completed.'; end if;
  return json_build_object('status','completed');
end; $$;

create or replace function public.refund_visit(p_actor uuid, p_visit_id uuid, p_reason text default '')
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v public.visits;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  select * into v from public.visits where id = p_visit_id;
  if not found then raise exception 'Visit not found.'; end if;
  if v.status = 'completed' then
    raise exception 'A completed visit cannot be refunded.';
  end if;
  update public.payments set status = 'refunded', note = coalesce(p_reason,'Refunded')
   where visit_id = p_visit_id and status = 'paid';
  update public.visits set status = 'refunded', refunded_at = now() where id = p_visit_id;
  return json_build_object('status','refunded');
end; $$;

create or replace function public.list_visits(p_actor uuid, p_filter text default 'all')
returns table (
  id uuid, visit_no text, status text, total numeric, created_at timestamptz,
  paid_at timestamptz, patient_id uuid, patient_no text, patient_name text, created_by_name text
)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  return query
    select v.id, v.visit_no, v.status, v.total, v.created_at, v.paid_at,
           p.id, p.patient_no, p.full_name,
           coalesce(e.full_name, e.username, '')
      from public.visits v
      join public.patients p on p.id = v.patient_id
      left join public.employees e on e.id = v.created_by
     where v.archived_at is null
       and (p_filter = 'all' or v.status = p_filter)
     order by v.created_at desc
     limit 200;
end; $$;

-- ---------------------------------------------------------------------
-- 8. DASHBOARD + REPORTS
-- ---------------------------------------------------------------------

create or replace function public.get_stats(p_actor uuid)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare r json;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  select json_build_object(
    'total_patients',   (select count(*) from public.patients),
    'patients_today',   (select count(*) from public.patients where registered_at::date = current_date),
    'total_visits',     (select count(*) from public.visits),
    'pending_payment',  (select count(*) from public.visits where status = 'pending_payment'),
    'in_lab',           (select count(*) from public.visits where status = 'in_lab'),
    'revenue_total',    (select coalesce(sum(amount),0) from public.payments where status = 'paid'),
    'revenue_today',    (select coalesce(sum(amount),0) from public.payments where status = 'paid' and paid_at::date = current_date),
    'total_employees',  (select count(*) from public.employees),
    'online_employees', (select count(*) from public.employees where last_seen > now() - interval '2 minutes'),
    'is_admin',         public.fn_is_admin(p_actor)
  ) into r;
  return r;
end; $$;

create or replace function public.get_charts(p_actor uuid)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_patients json; v_revenue json; v_status json; v_gender json;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_patients from (
    select to_char(d.day,'Mon DD') as label, coalesce(c.cnt,0) as value
    from generate_series(current_date - interval '13 days', current_date, interval '1 day') d(day)
    left join (
      select registered_at::date as day, count(*) cnt
      from public.patients group by 1
    ) c on c.day = d.day::date
    order by d.day
  ) t;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_revenue from (
    select to_char(d.day,'Mon DD') as label, coalesce(c.sum,0) as value
    from generate_series(current_date - interval '13 days', current_date, interval '1 day') d(day)
    left join (
      select paid_at::date as day, sum(amount) sum
      from public.payments where status = 'paid' group by 1
    ) c on c.day = d.day::date
    order by d.day
  ) t;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_status from (
    select status as label, count(*) as value
    from public.visits group by status order by status
  ) t;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_gender from (
    select coalesce(nullif(trim(gender),''),'Unspecified') as label, count(*) as value
    from public.patients group by 1 order by 2 desc
  ) t;

  return json_build_object(
    'patients_by_day', v_patients, 'revenue_by_day', v_revenue,
    'visits_by_status', v_status, 'patients_by_gender', v_gender
  );
end; $$;

-- Rows for Excel export. p_type: 'patients' | 'payments' | 'visits'
create or replace function public.get_report(
  p_actor uuid, p_type text, p_from date default null, p_to date default null
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare r json;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;

  if p_type = 'patients' then
    select coalesce(json_agg(row_to_json(t) order by t."Registered At"), '[]'::json) into r from (
      select p.patient_no as "Patient No", p.full_name as "Name", p.age as "Age",
             p.gender as "Gender", p.address as "Address", p.contact as "Contact",
             p.referred_by as "Referred By",
             coalesce(e.full_name, e.username, '') as "Registered By",
             to_char(p.registered_at,'YYYY-MM-DD HH24:MI') as "Registered At"
      from public.patients p
      left join public.employees e on e.id = p.registered_by
      where (p_from is null or p.registered_at::date >= p_from)
        and (p_to   is null or p.registered_at::date <= p_to)
    ) t;
  elsif p_type = 'payments' then
    select coalesce(json_agg(row_to_json(t) order by t."Paid At"), '[]'::json) into r from (
      select pay.id as "Payment ID", v.visit_no as "Visit No", pt.patient_no as "Patient No",
             pt.full_name as "Patient", pay.amount as "Amount", pay.method as "Method",
             pay.status as "Status",
             to_char(pay.paid_at,'YYYY-MM-DD HH24:MI') as "Paid At"
      from public.payments pay
      join public.visits v on v.id = pay.visit_id
      join public.patients pt on pt.id = v.patient_id
      where (p_from is null or pay.paid_at::date >= p_from)
        and (p_to   is null or pay.paid_at::date <= p_to)
    ) t;
  else
    select coalesce(json_agg(row_to_json(t) order by t."Created At"), '[]'::json) into r from (
      select v.visit_no as "Visit No", pt.patient_no as "Patient No", pt.full_name as "Patient",
             v.status as "Status", v.total as "Total",
             coalesce(e.full_name, e.username, '') as "Handled By",
             to_char(v.created_at,'YYYY-MM-DD HH24:MI') as "Created At"
      from public.visits v
      join public.patients pt on pt.id = v.patient_id
      left join public.employees e on e.id = v.created_by
      where (p_from is null or v.created_at::date >= p_from)
        and (p_to   is null or v.created_at::date <= p_to)
    ) t;
  end if;

  return r;
end; $$;

-- ---------------------------------------------------------------------
-- 9. GRANTS (expose only the functions to the anon/publishable key)
-- ---------------------------------------------------------------------

grant execute on function public.login(text,text)                         to anon, authenticated;
grant execute on function public.heartbeat(uuid)                          to anon, authenticated;
grant execute on function public.logout(uuid)                             to anon, authenticated;
grant execute on function public.list_employees(uuid)                     to anon, authenticated;
grant execute on function public.create_employee(uuid,text,text,text,text) to anon, authenticated;
grant execute on function public.update_employee(uuid,uuid,text,text,text) to anon, authenticated;
grant execute on function public.set_employee_active(uuid,uuid,boolean)   to anon, authenticated;
grant execute on function public.list_services(uuid)                      to anon, authenticated;
grant execute on function public.upsert_service(uuid,uuid,text,text,numeric) to anon, authenticated;
grant execute on function public.create_patient(uuid,text,integer,text,text,text,text) to anon, authenticated;
grant execute on function public.search_patients(uuid,text)               to anon, authenticated;
grant execute on function public.get_patient_record(uuid,uuid)            to anon, authenticated;
grant execute on function public.create_visit(uuid,uuid,jsonb)            to anon, authenticated;
grant execute on function public.record_payment(uuid,uuid,text,numeric)   to anon, authenticated;
grant execute on function public.start_lab(uuid,uuid)                     to anon, authenticated;
grant execute on function public.complete_visit(uuid,uuid)                to anon, authenticated;
grant execute on function public.refund_visit(uuid,uuid,text)             to anon, authenticated;
grant execute on function public.list_visits(uuid,text)                   to anon, authenticated;
grant execute on function public.get_stats(uuid)                          to anon, authenticated;
grant execute on function public.get_charts(uuid)                         to anon, authenticated;
grant execute on function public.get_report(uuid,text,date,date)          to anon, authenticated;

-- ---------------------------------------------------------------------
-- 10. SEED DATA
-- ---------------------------------------------------------------------

-- Default accounts (change the passwords after your first login).
insert into public.employees (username, full_name, role, password_hash)
values ('admin', 'Clinic Administrator', 'admin', crypt('admin123', gen_salt('bf')))
on conflict (username) do nothing;

insert into public.employees (username, full_name, role, password_hash)
values ('employee', 'Front Desk Employee', 'employee', crypt('employee123', gen_salt('bf')))
on conflict (username) do nothing;

-- Services catalog (prices default to 0 - edit them in the app).
insert into public.services (category, name, price) values
 ('Laboratory - Chemistry','Fasting Blood Sugar (FBS)',0),
 ('Laboratory - Chemistry','Cholesterol',0),
 ('Laboratory - Chemistry','Triglycerides',0),
 ('Laboratory - Chemistry','Lipid Profile',0),
 ('Laboratory - Chemistry','Sodium',0),
 ('Laboratory - Chemistry','Potassium',0),
 ('Laboratory - Chemistry','Chloride',0),
 ('Laboratory - Chemistry','Calcium',0),
 ('Laboratory - Chemistry','Creatinine',0),
 ('Laboratory - Chemistry','Blood Urea Nitrogen (BUN)',0),
 ('Laboratory - Chemistry','Blood Uric Acid (BUA)',0),
 ('Laboratory - Chemistry','SGPT / ALT',0),
 ('Laboratory - Chemistry','SGOT / ALT',0),
 ('Laboratory - Chemistry','Alkaline Phosphatase (ALP)',0),
 ('Laboratory - Chemistry','Urine Pregnancy Test',0),
 ('Laboratory - Chemistry','Serum Pregnancy Test',0),
 ('Laboratory - Chemistry','HbA1c',0),
 ('Laboratory - Chemistry','75g Oral Glucose Tolerance Test (OGTT)',0),
 ('Laboratory - Serology','Free T3 (FT3)',0),
 ('Laboratory - Serology','Free T4 (FT4)',0),
 ('Laboratory - Serology','Thyroid Stimulating Hormone (TSH)',0),
 ('Laboratory - Serology','Hepatitis B Surface Antigen (HBsAg)',0),
 ('Laboratory - Serology','Hepatitis A Virus IgM (HAV IgM)',0),
 ('Laboratory - Serology','Prostate Specific Antigen (PSA)',0),
 ('Laboratory - Serology','Dengue NS1 Ag',0),
 ('Laboratory - Serology','Human Immunodeficiency Virus (HIV)',0),
 ('Laboratory - Serology','Rapid Plasma Reagin (RPR)',0),
 ('Laboratory - Hematology / Blood Bank','Complete Blood Count (CBC)',0),
 ('Laboratory - Hematology / Blood Bank','Erythrocyte Sedimentation Rate (ESR)',0),
 ('Laboratory - Hematology / Blood Bank','Peripheral Blood Smear (PBS)',0),
 ('Laboratory - Hematology / Blood Bank','Blood Typing',0),
 ('Laboratory - Hematology / Blood Bank','Urinalysis',0),
 ('Laboratory - Hematology / Blood Bank','Fecalysis',0),
 ('Laboratory - Hematology / Blood Bank','Occult Blood',0),
 ('Laboratory - Hematology / Blood Bank','H. Pylori Antigen Detection',0),
 ('Laboratory - Hematology / Blood Bank','Drug Test',0),
 ('Laboratory - Hematology / Blood Bank','Sperm Analysis',0),
 ('Radiology / Ultrasound','Whole Abdomen',0),
 ('Radiology / Ultrasound','Lower Abdomen',0),
 ('Radiology / Ultrasound','Upper Abdomen',0),
 ('Radiology / Ultrasound','Kidney Ureter Bladder (KUB)',0),
 ('Radiology / Ultrasound','Hepatobiliary Tree (HBT)',0),
 ('Radiology / Ultrasound','Biophysical Score (BPS)',0),
 ('Radiology / Ultrasound','Trans-Vaginal',0),
 ('Radiology / Ultrasound','Trans-Rectal',0),
 ('Radiology / Ultrasound','Thyroid / Neck',0),
 ('Radiology / Ultrasound','Electronic Fetal Monitoring (EFM)',0),
 ('Radiology / Ultrasound','Cardiotocography (CTG)',0),
 ('Radiology / Ultrasound','Pelvic',0),
 ('Radiology / Ultrasound','Scrotal',0),
 ('Radiology / Ultrasound','Breast',0),
 ('Radiology / Ultrasound','Chest',0),
 ('Radiology / Ultrasound','NST',0),
 ('X-Ray','Chest PA',0),
 ('X-Ray','Chest AP / Pedia',0),
 ('X-Ray','Chest APL / Pedia',0),
 ('X-Ray','APICO',0),
 ('X-Ray','LSV APL',0),
 ('X-Ray','LSV APLO',0),
 ('X-Ray','Cervical APL',0),
 ('X-Ray','Cervical APLO',0),
 ('X-Ray','Plain Abdomen',0),
 ('X-Ray','Skull Series',0),
 ('X-Ray','PNS',0),
 ('X-Ray','TLV APL',0),
 ('X-Ray','TLV APLO',0),
 ('X-Ray','TCAGE AP',0),
 ('X-Ray','Pelvic Bone AP',0),
 ('X-Ray','Orbital Series',0),
 ('X-Ray','Nasal Bone',0),
 ('X-Ray','Leg APL',0),
 ('X-Ray','Thigh APL',0),
 ('X-Ray','Shoulder AP',0),
 ('X-Ray','Elbow APL',0),
 ('X-Ray','Hand APL',0),
 ('X-Ray','Wrist APL',0),
 ('X-Ray','Forearm APL',0),
 ('X-Ray','Foot APL',0),
 ('X-Ray','Ankle APL',0),
 ('X-Ray','Calcaneus AP',0),
 ('X-Ray','Knee APL',0),
 ('X-Ray','Clavicle AP',0),
 ('Other Services','2D Echo with Doppler',0),
 ('Other Services','Electrocardiogram (ECG)',0)
on conflict (category, name) do nothing;

-- ---------------------------------------------------------------------
-- 11. ACTIVITY LOG (who did what) + logging inside the action RPCs
-- ---------------------------------------------------------------------

create table if not exists public.activity_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references public.employees(id) on delete set null,
  actor_name text,
  action     text not null,
  details    text,
  created_at timestamptz not null default now()
);
alter table public.activity_log add column if not exists actor_id   uuid;
alter table public.activity_log add column if not exists actor_name text;
alter table public.activity_log add column if not exists action     text;
alter table public.activity_log add column if not exists details    text;
alter table public.activity_log add column if not exists created_at timestamptz default now();
create index if not exists idx_activity_created on public.activity_log (created_at desc);
alter table public.activity_log enable row level security;

create or replace function public.fn_log(p_actor uuid, p_action text, p_details text default '')
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_name text;
begin
  select coalesce(nullif(full_name,''), username) into v_name
    from public.employees where id = p_actor;
  insert into public.activity_log (actor_id, actor_name, action, details)
  values (p_actor, coalesce(v_name,'System'), p_action, coalesce(p_details,''));
end; $$;

create or replace function public.list_activity(
  p_actor uuid, p_limit integer default 150, p_from date default null, p_to date default null
)
returns setof public.activity_log
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can view the activity log.';
  end if;
  return query
    select a.* from public.activity_log a
     where (p_from is null or a.created_at::date >= p_from)
       and (p_to   is null or a.created_at::date <= p_to)
     order by a.created_at desc
     limit greatest(1, least(coalesce(p_limit,150), 500));
end; $$;

-- ---- Re-created action RPCs now write to the activity log ----------

create or replace function public.login(p_username text, p_password text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v public.employees;
begin
  select * into v from public.employees where lower(username) = lower(trim(p_username)) limit 1;
  if not found then
    raise exception 'Invalid username or password.';
  end if;
  if v.password_hash is null or crypt(p_password, v.password_hash) <> v.password_hash then
    raise exception 'Invalid username or password.';
  end if;
  if not v.is_active then
    raise exception 'This account is not active. Please contact the administrator.';
  end if;
  update public.employees set last_seen = now() where id = v.id;
  perform public.fn_log(v.id, 'login', 'Signed in as ' || v.role);
  return json_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role
  );
end; $$;

create or replace function public.logout(p_actor uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.fn_log(p_actor, 'logout', 'Signed out');
  update public.employees
     set last_seen = now() - interval '1 day'
   where id = p_actor;
end; $$;

create or replace function public.create_employee(
  p_actor uuid, p_username text, p_password text, p_full_name text, p_role text default 'employee'
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can create accounts.';
  end if;
  if length(trim(coalesce(p_username,''))) < 3 then
    raise exception 'Username must be at least 3 characters.';
  end if;
  if length(coalesce(p_password,'')) < 4 then
    raise exception 'Password must be at least 4 characters.';
  end if;
  if exists (select 1 from public.employees where lower(username) = lower(trim(p_username))) then
    raise exception 'That username is already taken.';
  end if;
  if p_role not in ('admin','employee') then
    raise exception 'Invalid role.';
  end if;
  insert into public.employees (username, full_name, role, password_hash)
  values (lower(trim(p_username)), trim(p_full_name), p_role, crypt(p_password, gen_salt('bf')))
  returning id into v_id;
  perform public.fn_log(p_actor, 'employee_create',
    'Created ' || p_role || ' account "' || lower(trim(p_username)) || '"');
  return json_build_object('id', v_id);
end; $$;

create or replace function public.update_employee(
  p_actor uuid, p_id uuid, p_full_name text, p_role text, p_password text default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_un text;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can modify accounts.';
  end if;
  update public.employees
     set full_name = trim(p_full_name),
         role = case when p_role in ('admin','employee') then p_role else role end,
         password_hash = case
           when p_password is not null and length(p_password) >= 4
             then crypt(p_password, gen_salt('bf'))
           else password_hash end
   where id = p_id
   returning username into v_un;
  perform public.fn_log(p_actor, 'employee_update',
    'Updated account "' || coalesce(v_un, p_id::text) || '"'
    || case when p_password is not null and length(p_password) >= 4 then ' (password reset)' else '' end);
end; $$;

create or replace function public.set_employee_active(p_actor uuid, p_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_un text;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can enable or disable accounts.';
  end if;
  if p_id = p_actor and p_active = false then
    raise exception 'You cannot disable your own account.';
  end if;
  update public.employees set is_active = p_active where id = p_id returning username into v_un;
  perform public.fn_log(p_actor,
    case when p_active then 'employee_enable' else 'employee_disable' end,
    (case when p_active then 'Enabled' else 'Disabled' end) || ' account "' || coalesce(v_un, p_id::text) || '"');
end; $$;

-- Admin only: permanently delete an account (its past records are kept; the
-- references just become unassigned via ON DELETE SET NULL).
create or replace function public.delete_employee(p_actor uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_un text; v_role text;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can delete accounts.';
  end if;
  if p_id = p_actor then
    raise exception 'You cannot delete your own account.';
  end if;
  select e.username, e.role into v_un, v_role from public.employees e where e.id = p_id;
  if v_un is null then
    raise exception 'Account not found.';
  end if;
  if v_role = 'admin'
     and (select count(*) from public.employees e where e.role = 'admin') <= 1 then
    raise exception 'You cannot delete the last administrator.';
  end if;
  perform public.fn_log(p_actor, 'employee_delete', 'Deleted account "' || v_un || '"');
  delete from public.employees where id = p_id;
end; $$;

-- ---- Archive (soft store): archived records leave the active lists but are
-- ---- kept here until an admin restores or permanently deletes them --------
create or replace function public.set_archived(p_actor uuid, p_type text, p_id uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_label text;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can archive or restore records.';
  end if;
  if p_type = 'patient' then
    update public.patients set archived_at = case when p_archived then now() else null end
      where id = p_id returning patient_no || ' - ' || full_name into v_label;
  elsif p_type = 'visit' then
    update public.visits set archived_at = case when p_archived then now() else null end
      where id = p_id returning visit_no into v_label;
  else
    raise exception 'Unknown record type.';
  end if;
  if v_label is null then raise exception 'Record not found.'; end if;
  perform public.fn_log(p_actor,
    case when p_archived then 'archive' else 'restore' end,
    (case when p_archived then 'Archived ' else 'Restored ' end) || p_type || ' "' || v_label || '"');
end; $$;

create or replace function public.list_archived(p_actor uuid)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_p json; v_v json;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can view the archives.';
  end if;
  select coalesce(json_agg(x order by x.archived_at desc), '[]'::json) into v_p from (
    select pt.id, pt.patient_no as ref, pt.full_name as name,
           trim(both ' ' from coalesce(pt.age::text,'') || ' ' ||
                case when pt.gender is null then '' else '/ ' || pt.gender end) as info,
           (select count(*) from public.visits v where v.patient_id = pt.id) as extra,
           pt.archived_at
      from public.patients pt where pt.archived_at is not null
  ) x;
  select coalesce(json_agg(x order by x.archived_at desc), '[]'::json) into v_v from (
    select v.id, v.visit_no as ref, p.full_name as name,
           p.patient_no || ' · ' || v.status as info,
           v.total as extra, v.archived_at
      from public.visits v join public.patients p on p.id = v.patient_id
     where v.archived_at is not null
  ) x;
  return json_build_object('patients', v_p, 'visits', v_v);
end; $$;

create or replace function public.delete_archived(p_actor uuid, p_type text, p_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_label text;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can delete archived records.';
  end if;
  if p_type = 'patient' then
    select patient_no || ' - ' || full_name into v_label
      from public.patients where id = p_id and archived_at is not null;
    if v_label is null then raise exception 'Archived patient not found.'; end if;
    perform public.fn_log(p_actor, 'purge', 'Permanently deleted archived patient "' || v_label || '"');
    delete from public.patients where id = p_id;
  elsif p_type = 'visit' then
    select visit_no into v_label from public.visits where id = p_id and archived_at is not null;
    if v_label is null then raise exception 'Archived visit not found.'; end if;
    perform public.fn_log(p_actor, 'purge', 'Permanently deleted archived visit "' || v_label || '"');
    delete from public.visits where id = p_id;
  else
    raise exception 'Unknown record type.';
  end if;
end; $$;

create or replace function public.upsert_service(
  p_actor uuid, p_id uuid, p_category text, p_name text, p_price numeric
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can manage services.';
  end if;
  if p_id is null then
    insert into public.services (category, name, price)
    values (trim(p_category), trim(p_name), coalesce(p_price,0))
    returning id into v_id;
  else
    update public.services
       set category = trim(p_category), name = trim(p_name), price = coalesce(p_price,0)
     where id = p_id
     returning id into v_id;
  end if;
  perform public.fn_log(p_actor, case when p_id is null then 'service_add' else 'service_edit' end,
    trim(p_name) || ' (price ' || coalesce(p_price,0) || ')');
  return json_build_object('id', v_id);
end; $$;

create or replace function public.create_patient(
  p_actor uuid, p_full_name text, p_age integer, p_gender text,
  p_address text, p_contact text, p_referred_by text
) returns public.patients
language plpgsql security definer set search_path = public, extensions as $$
declare v public.patients;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  if length(trim(coalesce(p_full_name,''))) < 2 then
    raise exception 'Patient name is required.';
  end if;
  insert into public.patients (patient_no, full_name, age, gender, address, contact, referred_by, registered_by)
  values (
    'P-' || lpad(nextval('public.patient_seq')::text, 5, '0'),
    trim(p_full_name), p_age, p_gender, trim(p_address), trim(p_contact), trim(p_referred_by), p_actor
  )
  returning * into v;
  perform public.fn_log(p_actor, 'patient_register', 'Registered ' || v.patient_no || ' - ' || v.full_name);
  return v;
end; $$;

-- Admin only: edit an existing patient's details.
create or replace function public.update_patient(
  p_actor uuid, p_id uuid, p_full_name text, p_age integer, p_gender text,
  p_address text, p_contact text, p_referred_by text
) returns public.patients
language plpgsql security definer set search_path = public, extensions as $$
declare v public.patients;
begin
  if not public.fn_is_admin(p_actor) then
    raise exception 'Only the administrator can edit patient details.';
  end if;
  if length(trim(coalesce(p_full_name,''))) < 2 then
    raise exception 'Patient name is required.';
  end if;
  update public.patients set
    full_name   = trim(p_full_name),
    age         = p_age,
    gender      = nullif(trim(p_gender), ''),
    address     = nullif(trim(p_address), ''),
    contact     = nullif(trim(p_contact), ''),
    referred_by = nullif(trim(p_referred_by), '')
  where id = p_id
  returning * into v;
  if v.id is null then
    raise exception 'Patient not found.';
  end if;
  perform public.fn_log(p_actor, 'patient_update', 'Updated ' || v.patient_no || ' - ' || v.full_name);
  return v;
end; $$;

create or replace function public.create_visit(p_actor uuid, p_patient_id uuid, p_items jsonb)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_visit public.visits; v_total numeric(12,2) := 0; it jsonb; v_pname text;
        v_admin boolean; v_price numeric; v_cat numeric; v_srv_id uuid; v_name text;
        v_fixed jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Please select at least one service.';
  end if;

  v_admin := public.fn_is_admin(p_actor);

  -- Prices always come from the catalog. Only the administrator may override them.
  for it in select * from jsonb_array_elements(p_items) loop
    v_srv_id := nullif(it->>'service_id','')::uuid;
    v_name   := coalesce(it->>'name','Service');
    v_price  := coalesce((it->>'price')::numeric, 0);
    if not v_admin and v_srv_id is not null then
      v_cat := null;
      select s.price, s.name into v_cat, v_name from public.services s where s.id = v_srv_id;
      if v_cat is not null then v_price := v_cat; end if;
      if v_name is null then v_name := coalesce(it->>'name','Service'); end if;
    end if;
    v_total := v_total + v_price;
    v_fixed := v_fixed || jsonb_build_array(
      jsonb_build_object('service_id', v_srv_id, 'name', v_name, 'price', v_price));
  end loop;

  insert into public.visits (visit_no, patient_id, status, total, created_by)
  values ('V-' || lpad(nextval('public.visit_seq')::text, 5, '0'), p_patient_id, 'pending_payment', v_total, p_actor)
  returning * into v_visit;

  for it in select * from jsonb_array_elements(v_fixed) loop
    insert into public.visit_items (visit_id, service_id, name, price)
    values (
      v_visit.id,
      nullif(it->>'service_id','')::uuid,
      coalesce(it->>'name','Service'),
      coalesce((it->>'price')::numeric, 0)
    );
  end loop;

  select full_name into v_pname from public.patients where id = p_patient_id;
  perform public.fn_log(p_actor, 'visit_create',
    'Created ' || v_visit.visit_no || ' for ' || coalesce(v_pname,'patient') ||
    ' (' || jsonb_array_length(p_items) || ' service/s, total ' || v_total || ')');
  return json_build_object('id', v_visit.id, 'visit_no', v_visit.visit_no, 'total', v_visit.total, 'status', v_visit.status);
end; $$;

create or replace function public.record_payment(p_actor uuid, p_visit_id uuid, p_method text, p_amount numeric)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v public.visits; v_amt numeric(12,2);
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  select * into v from public.visits where id = p_visit_id;
  if not found then raise exception 'Visit not found.'; end if;
  if v.status in ('paid','in_lab','completed') then
    raise exception 'This visit is already paid.';
  end if;
  if v.status = 'refunded' then
    raise exception 'This visit was refunded.';
  end if;
  v_amt := coalesce(p_amount, v.total);
  insert into public.payments (visit_id, amount, method, status, received_by)
  values (p_visit_id, v_amt, coalesce(p_method,'Cash'), 'paid', p_actor);
  update public.visits set status = 'paid', paid_at = now() where id = p_visit_id;
  perform public.fn_log(p_actor, 'payment',
    'Collected ' || v_amt || ' for ' || v.visit_no || ' (' || coalesce(p_method,'Cash') || ')');
  return json_build_object('status','paid');
end; $$;

create or replace function public.start_lab(p_actor uuid, p_visit_id uuid)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v public.visits;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  select * into v from public.visits where id = p_visit_id;
  if not found then raise exception 'Visit not found.'; end if;
  if v.status = 'pending_payment' then
    raise exception 'Payment is required before proceeding to the laboratory.';
  end if;
  if v.status = 'refunded' then
    raise exception 'This visit was refunded and cannot proceed.';
  end if;
  update public.visits set status = 'in_lab', lab_at = now() where id = p_visit_id;
  perform public.fn_log(p_actor, 'lab_start', 'Sent ' || v.visit_no || ' to the laboratory');
  return json_build_object('status','in_lab');
end; $$;

create or replace function public.complete_visit(p_actor uuid, p_visit_id uuid)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_no text;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  update public.visits set status = 'completed', completed_at = now()
   where id = p_visit_id and status in ('paid','in_lab')
   returning visit_no into v_no;
  if v_no is null then raise exception 'Only a paid or in-lab visit can be completed.'; end if;
  perform public.fn_log(p_actor, 'visit_complete', 'Completed ' || v_no);
  return json_build_object('status','completed');
end; $$;

create or replace function public.refund_visit(p_actor uuid, p_visit_id uuid, p_reason text default '')
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v public.visits;
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  select * into v from public.visits where id = p_visit_id;
  if not found then raise exception 'Visit not found.'; end if;
  if v.status = 'completed' then
    raise exception 'A completed visit cannot be refunded.';
  end if;
  update public.payments set status = 'refunded', note = coalesce(p_reason,'Refunded')
   where visit_id = p_visit_id and status = 'paid';
  update public.visits set status = 'refunded', refunded_at = now() where id = p_visit_id;
  perform public.fn_log(p_actor, 'refund',
    'Refunded ' || v.visit_no || coalesce(nullif(': ' || trim(p_reason), ': '), ''));
  return json_build_object('status','refunded');
end; $$;

grant execute on function public.list_activity(uuid,integer,date,date) to anon, authenticated;

-- Grants for the RPCs defined in this section. They must come AFTER each
-- CREATE, otherwise GRANT ... ON FUNCTION fails with "does not exist".
grant execute on function public.delete_employee(uuid,uuid)               to anon, authenticated;
grant execute on function public.set_archived(uuid,text,uuid,boolean)     to anon, authenticated;
grant execute on function public.list_archived(uuid)                      to anon, authenticated;
grant execute on function public.delete_archived(uuid,text,uuid)          to anon, authenticated;
grant execute on function public.update_patient(uuid,uuid,text,integer,text,text,text,text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 12. RECEIPTS (searchable repository + optional uploaded files)
-- ---------------------------------------------------------------------

-- Optional scanned/photo receipt uploaded per visit (stored as base64).
create table if not exists public.receipt_files (
  id          uuid primary key default gen_random_uuid(),
  visit_id    uuid not null references public.visits(id) on delete cascade,
  file_name   text,
  mime_type   text,
  data        text not null,
  uploaded_by uuid references public.employees(id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table public.receipt_files add column if not exists visit_id    uuid;
alter table public.receipt_files add column if not exists file_name   text;
alter table public.receipt_files add column if not exists mime_type   text;
alter table public.receipt_files add column if not exists data        text;
alter table public.receipt_files add column if not exists uploaded_by uuid;
alter table public.receipt_files add column if not exists created_at  timestamptz default now();
create index if not exists idx_receipt_files_visit on public.receipt_files (visit_id);
alter table public.receipt_files enable row level security;

-- One row per visit: everything needed to show/search/print a receipt.
create or replace function public.list_receipts(p_actor uuid, p_query text default '')
returns table (
  visit_id uuid, receipt_no text, visit_no text, patient_id uuid, patient_no text, patient_name text,
  status text, total numeric, amount_paid numeric, method text,
  has_file boolean, created_at timestamptz, paid_at timestamptz
)
language plpgsql security definer set search_path = public, extensions as $$
declare q text := lower(trim(coalesce(p_query,'')));
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  return query
    select v.id,
           upper(substr(v.id::text,1,8))::text,
           v.visit_no, p.id, p.patient_no, p.full_name,
           v.status, v.total,
           coalesce((select sum(pay.amount) from public.payments pay where pay.visit_id = v.id and pay.status = 'paid'), 0),
           coalesce((select pay.method from public.payments pay where pay.visit_id = v.id order by pay.paid_at desc limit 1), '-'),
           exists(select 1 from public.receipt_files f where f.visit_id = v.id),
           v.created_at, v.paid_at
      from public.visits v
      join public.patients p on p.id = v.patient_id
     where v.archived_at is null
       and (q = ''
        or lower(v.visit_no)   like '%'||q||'%'
        or lower(p.full_name)  like '%'||q||'%'
        or lower(p.patient_no) like '%'||q||'%'
        or lower(substr(v.id::text,1,8)) like '%'||q||'%')
     order by coalesce(v.paid_at, v.created_at) desc
     limit 300;
end; $$;

-- Save (replace) an uploaded receipt file for a visit.
create or replace function public.save_receipt_file(
  p_actor uuid, p_visit_id uuid, p_file_name text, p_mime text, p_data text
) returns json
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  if coalesce(p_data,'') = '' then raise exception 'No file data received.'; end if;
  if not exists (select 1 from public.visits where id = p_visit_id) then
    raise exception 'Visit not found.';
  end if;
  delete from public.receipt_files where visit_id = p_visit_id;
  insert into public.receipt_files (visit_id, file_name, mime_type, data, uploaded_by)
  values (p_visit_id, left(coalesce(nullif(p_file_name,''),'receipt'), 160),
          coalesce(nullif(p_mime,''),'application/octet-stream'), p_data, p_actor);
  perform public.fn_log(p_actor, 'receipt_upload', 'Uploaded a receipt file');
  return json_build_object('ok', true);
end; $$;

create or replace function public.get_receipt_file(p_actor uuid, p_visit_id uuid)
returns setof public.receipt_files
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.employees e where e.id = p_actor and e.is_active) then
    raise exception 'Please sign in again.';
  end if;
  return query select rf.* from public.receipt_files rf where rf.visit_id = p_visit_id order by rf.created_at desc limit 1;
end; $$;

grant execute on function public.list_receipts(uuid,text)                  to anon, authenticated;
grant execute on function public.save_receipt_file(uuid,uuid,text,text,text) to anon, authenticated;
grant execute on function public.get_receipt_file(uuid,uuid)               to anon, authenticated;

-- Ask PostgREST (Supabase's REST layer) to reload its schema cache so the
-- new/updated RPCs are callable immediately (avoids "function not found").
notify pgrst, 'reload schema';

-- Commit the whole script (rebuilds every RPC = one atomic change).
commit;

-- =====================================================================
--  Done. You can now log in at login.html with admin / admin123
-- =====================================================================
