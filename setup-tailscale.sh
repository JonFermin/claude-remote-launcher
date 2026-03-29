#!/usr/bin/env bash
# Expose the launcher via Tailscale Funnel (HTTPS from the internet)
# or Tailscale Serve (only accessible within your tailnet)
#
# Option A: Tailnet-only (recommended — only your devices can reach it)
#   tailscale serve --bg 3777
#
# Option B: Public internet via Funnel (use with caution, token protects it)
#   tailscale funnel --bg 3777
#
# Check status:
#   tailscale serve status
#   tailscale funnel status
#
# Your endpoint will be: https://<your-machine-name>.<tailnet>.ts.net/
# Use that URL from your phone, another laptop, CI, etc.

echo "Choose exposure mode:"
echo "  1) tailnet-only (tailscale serve) — recommended"
echo "  2) public internet (tailscale funnel)"
read -rp "Enter 1 or 2: " choice

case $choice in
  1) tailscale serve --bg 3777
     echo "Accessible at https://$(tailscale status --json | python -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
     ;;
  2) tailscale funnel --bg 3777
     echo "Publicly accessible via Tailscale Funnel"
     ;;
  *) echo "Invalid choice"; exit 1 ;;
esac
