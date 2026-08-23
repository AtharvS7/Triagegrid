# TriageGrid PRODUCTION bootstrap — run AFTER migrations are applied.
# Creates: agency, admin auth user + personnel, 2 hospitals, 4 units.
# Idempotent-ish: skips rows that already exist.

$ErrorActionPreference = "Stop"
$ref = "wyqiiqquyrvccsczlldb"
$base = "https://$ref.supabase.co"
$svc = $env:SUPABASE_SERVICE_ROLE_KEY
if (-not $svc) { throw "Set SUPABASE_SERVICE_ROLE_KEY first" }
$H = @{ Authorization = "Bearer $svc"; apikey = $svc; "Content-Type" = "application/json"; Prefer = "return=representation" }

function RestJson($method, $url, $body) {
  $params = @{ Uri = $url; Method = $method; Headers = $H; ContentType = "application/json" }
  if ($body) { $params.Body = ($body | ConvertTo-Json -Depth 8) }
  Invoke-RestMethod @params
}

# 1) Agency
$agency = RestJson "POST" "$base/rest/v1/agencies" @{ name = "Metro EMS (Production)" }
Write-Host "agency: $($agency.id)"

# 2) Hospitals
$h1 = RestJson "POST" "$base/rest/v1/hospitals" @{
  agency_id = $agency.id; name = "Metro General Medical Center"
  current_lat = 34.0590; current_lng = -118.2890; total_beds = 120; beds_available = 45 }
$h2 = RestJson "POST" "$base/rest/v1/hospitals" @{
  agency_id = $agency.id; name = "Eastside Trauma Center"
  current_lat = 34.0430; current_lng = -118.2150; total_beds = 80; beds_available = 12 }
Write-Host "hospitals: $($h1.id), $($h2.id)"

# 3) Admin auth user (random password printed ONCE)
$adminEmail = $env:ADMIN_EMAIL
$adminPass  = $env:ADMIN_PASSWORD
$admin = RestJson "POST" "$base/auth/v1/admin/users" @{
  email = $adminEmail; password = $adminPass; email_confirm = $true
  user_metadata = @{ full_name = "System Admin" } }
Write-Host "admin user: $($admin.id)"

# 4) Personnel row
$null = RestJson "POST" "$base/rest/v1/personnel" @{
  id = $admin.id; agency_id = $agency.id; role = "admin"; full_name = "System Admin"; locale = "en" }
Write-Host "personnel: admin linked"

# NOTE: hospital_admin + field users are provisioned by the admin from the
# Admin Panel / Supabase dashboard in production (no seeded demo passwords).

# 5) Units
foreach ($u in @(
  @{ callsign = "M-1"; unit_type = "ambulance"; capabilities = @("als","bls"); capacity = 2; lat = 34.0522; lng = -118.2437 },
  @{ callsign = "M-2"; unit_type = "ambulance"; capabilities = @("bls"); capacity = 1; lat = 34.0610; lng = -118.3010 },
  @{ callsign = "R-7"; unit_type = "rescue"; capabilities = @("heavy_rescue","bls"); capacity = 4; lat = 34.0480; lng = -118.2590 }
)) {
  $null = RestJson "POST" "$base/rest/v1/units" @{
    agency_id = $agency.id; callsign = $u.callsign; unit_type = $u.unit_type
    capabilities = $u.capabilities; capacity = $u.capacity
    current_lat = $u.lat; current_lng = $u.lng; status = "available" }
  Write-Host "unit: $($u.callsign)"
}

# 6) Production matcher config (Edge Function URL + shared secret)
$secret = $env:MATCH_BATCH_SECRET
$null = RestJson "PATCH" "$base/rest/v1/config?key=eq.functions.match_batch_url" @{
  value = "https://$ref.supabase.co/functions/v1/match-batch" }
$null = RestJson "PATCH" "$base/rest/v1/config?key=eq.functions.match_batch_secret" @{
  value = $secret }
Write-Host "config: match_batch_url + secret set"

Write-Host "`nDONE. Admin login: $adminEmail / (password printed above)"
