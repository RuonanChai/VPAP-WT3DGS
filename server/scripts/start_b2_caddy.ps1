# B2: Caddy HTTP/3 static (see Caddyfile.b2.example)
Set-Location $PSScriptRoot\..
if (-not (Get-Command caddy -ErrorAction SilentlyContinue)) {
    Write-Error "Install Caddy v2+ and add it to PATH: https://caddyserver.com/docs/install"
    exit 1
}
caddy run --config Caddyfile.b2.example
