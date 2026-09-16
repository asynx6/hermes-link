$existing = Get-NetFirewallRule -DisplayName 'PORT HERMES-INTAKE 8080' -ErrorAction SilentlyContinue
if (-not $existing) {
  New-NetFirewallRule -DisplayName 'PORT HERMES-INTAKE 8080' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow | Out-Null
  Write-Host 'firewall rule added'
} else {
  Write-Host 'rule already exists'
}
