-- ═════════════════════════════════════════════════════════════════════════════
-- TRIAGEGRID SEED — local development only.
-- Creates one agency, five personnel identities (all four roles + a second
-- field responder), units, hospitals. Passwords are dev-only defaults;
-- NEVER run this against production (supabase seeds only apply to local DBs).
-- Insert order respects FKs: agencies → auth → hospitals → personnel → units.
-- ═════════════════════════════════════════════════════════════════════════════

insert into public.agencies (id, name)
values ('11111111-1111-1111-1111-111111111111', 'Metro EMS')
on conflict do nothing;

insert into auth.users (
  id, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
)
values
  ('aaaaaaaa-0000-0000-0000-00000000aaa1', 'admin@triagegrid.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Avery Admin"}'),
  ('aaaaaaaa-0000-0000-0000-00000000aaa2', 'dispatch@triagegrid.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Dee Spatcher"}'),
  ('aaaaaaaa-0000-0000-0000-00000000aaa3', 'field@triagegrid.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Finn Responder"}'),
  ('aaaaaaaa-0000-0000-0000-00000000aaa4', 'hospital@triagegrid.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Holly Admin"}'),
  ('aaaaaaaa-0000-0000-0000-00000000aaa5', 'field2@triagegrid.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Rosa Medic"}')
on conflict (id) do nothing;

-- GoTrue refuses login when flow-token columns are NULL (reads as "pending
-- confirmation"). Native signups store empty strings; mirror that here.
update auth.users
set confirmation_token = '', recovery_token = '', email_change_token_new = '',
    email_change = '',
    -- GoTrue filters logins on audience + instance; native signups set these:
    aud = 'authenticated', role = 'authenticated',
    instance_id = '00000000-0000-0000-0000-000000000000'
where id::text like 'aaaaaaaa-%';
-- NOTE: provider_id must be unique per user (UNIQUE(provider, provider_id)) —
-- use the user id, NOT the literal string 'email'.
insert into auth.identities (
  id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(), u.id, 'email', u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  now(), now(), now()
from auth.users u
where u.id::text like 'aaaaaaaa-%'
on conflict do nothing;

insert into public.hospitals (id, agency_id, name, current_lat, current_lng,
                              total_beds, beds_available)
values
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
   'Metro General Medical Center', 34.0590, -118.2890, 120, 45),
  ('33333333-3333-3333-3333-333333333334', '11111111-1111-1111-1111-111111111111',
   'Eastside Trauma Center', 34.0430, -118.2150, 80, 12)
on conflict (id) do nothing;

insert into public.personnel (id, agency_id, role, full_name, locale, hospital_id)
values
  ('aaaaaaaa-0000-0000-0000-00000000aaa1', '11111111-1111-1111-1111-111111111111',
   'admin', 'Avery Admin', 'en', null),
  ('aaaaaaaa-0000-0000-0000-00000000aaa2', '11111111-1111-1111-1111-111111111111',
   'dispatcher', 'Dee Spatcher', 'en', null),
  ('aaaaaaaa-0000-0000-0000-00000000aaa3', '11111111-1111-1111-1111-111111111111',
   'field', 'Finn Responder', 'en', null),
  ('aaaaaaaa-0000-0000-0000-00000000aaa4', '11111111-1111-1111-1111-111111111111',
   'hospital_admin', 'Holly Admin', 'en', '33333333-3333-3333-3333-333333333333'),
  ('aaaaaaaa-0000-0000-0000-00000000aaa5', '11111111-1111-1111-1111-111111111111',
   'field', 'Rosa Medic', 'es', null)
on conflict (id) do nothing;

insert into public.units (id, agency_id, callsign, unit_type, capabilities, capacity,
                          current_lat, current_lng, status, assigned_to)
values
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'M-1', 'ambulance', array['als','bls'], 2, 34.0522, -118.2437, 'available',
   'aaaaaaaa-0000-0000-0000-00000000aaa3'),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'M-2', 'ambulance', array['bls'], 1, 34.0610, -118.3010, 'available',
   'aaaaaaaa-0000-0000-0000-00000000aaa5'),
  ('22222222-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'R-7', 'rescue', array['heavy_rescue','bls'], 4, 34.0480, -118.2590,
   'available', null),
  ('22222222-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   'M-3', 'ambulance', array['als'], 2, 34.0700, -118.2200, 'offline', null)
on conflict (id) do nothing;
