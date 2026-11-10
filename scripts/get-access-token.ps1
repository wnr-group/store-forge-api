<#
.SYNOPSIS
  Signs in to Supabase Auth with email + password and copies the access token to the clipboard.

.DESCRIPTION
  For testing the StoreForge API from Swagger UI (http://localhost:4000/api/docs):
    npm run auth:token   ->   paste into Swagger "Authorize"   ->   call endpoints.

  - Reads SUPABASE_URL and SUPABASE_ANON_KEY from the environment, else from .env in the repository root (read-only).
  - Asks for the email and (hidden) password. The password is only used for this one request.
  - Calls Supabase Auth: POST {SUPABASE_URL}/auth/v1/token?grant_type=password with the anon key in the `apikey` header.
    Supabase is the only token issuer; nothing is generated here.
  - Copies the access token with Set-Clipboard. The token and password are NEVER printed, logged or written to disk,
    and .env is never modified.
  - Works in Windows PowerShell 5.1 and PowerShell 7.

.PARAMETER Email
  Optional. Skips the email prompt.
#>
[CmdletBinding()]
param([string] $Email)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 may default to TLS 1.0, which Supabase refuses.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

function Fail([string] $Message) {
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

# --- Configuration ---------------------------------------------------------------------------------------------------

$repoRoot = Split-Path -Parent $PSScriptRoot

# Minimal, read-only .env reader: KEY=value, optional quotes, comments ignored. Does not touch the environment.
function Read-DotEnv([string] $Path) {
  $values = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $values }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $value = $Matches[2]
      if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") { $value = $Matches[1] }
      $values[$Matches[1]] = $value
    }
  }
  return $values
}

$dotenv = Read-DotEnv (Join-Path $repoRoot '.env')
function Setting([string] $Name) {
  $fromEnv = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($fromEnv)) { return $fromEnv.Trim() }
  if ($dotenv.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($dotenv[$Name])) { return $dotenv[$Name].Trim() }
  return $null
}

$supabaseUrl = Setting 'SUPABASE_URL'
$anonKey = Setting 'SUPABASE_ANON_KEY'
$missing = @()
if (-not $supabaseUrl) { $missing += 'SUPABASE_URL' }
if (-not $anonKey) { $missing += 'SUPABASE_ANON_KEY' }
if ($missing.Count -gt 0) {
  Fail ("Missing $($missing -join ' and '). Set them in .env (see .env.example) or as environment variables. Nothing was sent.")
}
$supabaseUrl = $supabaseUrl.TrimEnd('/')
if ($supabaseUrl -notmatch '^https?://') { Fail 'SUPABASE_URL must start with https:// (or http:// for a local Supabase).' }

# --- Credentials -----------------------------------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($Email)) { $Email = Read-Host 'Supabase email' }
$Email = $Email.Trim().ToLowerInvariant()
if ($Email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Fail 'That does not look like an email address.' }

$securePassword = Read-Host 'Password' -AsSecureString
if ($null -eq $securePassword -or $securePassword.Length -eq 0) { Fail 'The password is empty.' }

# --- Request ---------------------------------------------------------------------------------------------------------

$bstr = [IntPtr]::Zero
$plainPassword = $null
$body = $null
$response = $null
try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $body = @{ email = $Email; password = $plainPassword } | ConvertTo-Json -Compress

  Write-Host "Signing in to $supabaseUrl ..."
  try {
    $response = Invoke-RestMethod -Method Post `
      -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
      -Headers @{ apikey = $anonKey } `
      -ContentType 'application/json' `
      -Body $body `
      -TimeoutSec 30
  }
  catch {
    # Supabase answers with JSON like {"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}.
    # PowerShell 7 fills ErrorDetails; Windows PowerShell 5.1 does not, so read the response body ourselves.
    $detailText = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detailText = $_.ErrorDetails.Message }
    elseif ($_.Exception.Response -and $_.Exception.Response.PSObject.Methods['GetResponseStream']) {
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $detailText = $reader.ReadToEnd()
        $reader.Dispose()
      } catch { }
    }
    $detail = $null
    if ($detailText) { try { $detail = $detailText | ConvertFrom-Json } catch { } }
    $status = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $status = [int] $_.Exception.Response.StatusCode }

    $code = $null
    if ($detail) { $code = if ($detail.error_code) { $detail.error_code } elseif ($detail.error) { $detail.error } else { $null } }

    if ($null -eq $status -and $null -eq $detail) {
      Fail "Could not reach Supabase at $supabaseUrl. Check your network and SUPABASE_URL. ($($_.Exception.Message))"
    }
    switch ($code) {
      'invalid_credentials' { Fail 'Wrong email or password.' }
      'email_not_confirmed' { Fail 'This account is not confirmed. StoreForge accounts are created pre-confirmed; ask an administrator.' }
      'user_banned' { Fail 'This account is disabled.' }
      'over_request_rate_limit' { Fail 'Too many attempts. Wait a minute and try again.' }
      default {
        if ($status -eq 401 -or $status -eq 403) { Fail "Supabase rejected the request ($status). Check that SUPABASE_ANON_KEY belongs to the project in SUPABASE_URL." }
        if ($status -eq 429) { Fail 'Too many attempts. Wait a minute and try again.' }
        $message = if ($detail -and $detail.msg) { $detail.msg } elseif ($detail -and $detail.error_description) { $detail.error_description } else { "HTTP $status" }
        Fail "Sign-in failed: $message"
      }
    }
  }
}
finally {
  # Clear what we can. (.NET strings are immutable, so dropping references is the best available.)
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $plainPassword = $null
  $body = $null
  $securePassword.Dispose()
}

if ($null -eq $response -or [string]::IsNullOrWhiteSpace($response.access_token)) {
  Fail 'Supabase answered without an access token.'
}

# --- Result ----------------------------------------------------------------------------------------------------------

try { Set-Clipboard -Value $response.access_token }
catch { Fail "Signed in, but the token could not be copied to the clipboard: $($_.Exception.Message)" }

$signedInAs = if ($response.user -and $response.user.email) { $response.user.email } else { $Email }
$expiresAt = $null
if ($response.expires_at) { $expiresAt = [DateTimeOffset]::FromUnixTimeSeconds([int64] $response.expires_at).ToLocalTime() }
elseif ($response.expires_in) { $expiresAt = [DateTimeOffset]::Now.AddSeconds([int64] $response.expires_in) }

Write-Host ''
Write-Host 'Access token copied to the clipboard.' -ForegroundColor Green
Write-Host "  Signed in as : $signedInAs"
if ($response.expires_in) { Write-Host "  Valid for    : $([math]::Round([int64] $response.expires_in / 60)) minutes" }
if ($expiresAt) { Write-Host "  Expires at   : $($expiresAt.ToString('yyyy-MM-dd HH:mm:ss zzz'))" }
Write-Host ''
Write-Host 'Next: open http://localhost:4000/api/docs -> Authorize -> paste (Ctrl+V) -> Authorize -> Close.'
Write-Host 'Do not type "Bearer": Swagger adds it.'

$response = $null
