# B2: HTTP/3 static + WSS RVC via Caddy (see Caddyfile.b2.example)
Set-Location $PSScriptRoot\..
if (-not (Get-Command caddy -ErrorAction SilentlyContinue)) {
    Write-Error "Install Caddy v2+ and add it to PATH: https://caddyserver.com/docs/install"
    exit 1
}
Write-Host "1) In another window: `$env:B1_STATIC_ENABLED='0'; `$env:B1_HTTP_PORT='7080'; node server_b1_http_rvc.js"
Write-Host "2) Starting Caddy on :7443 ..."
caddy run --config Caddyfile.b2.example
