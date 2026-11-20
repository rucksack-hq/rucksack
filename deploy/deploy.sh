#!/bin/sh
# Deploy to the Skillnet server: ./deploy/deploy.sh   (ssh alias skillnet = ubuntu@135.148.170.44)
set -e
cd "$(dirname "$0")/.."
H=${SKILLNET_HOST:-skillnet}
npm test >/dev/null
rsync -az --delete --rsync-path='sudo rsync' --exclude .git --exclude data --exclude node_modules ./ "$H:/opt/skillnet/"
ssh "$H" 'sudo cp /opt/skillnet/deploy/*.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable -q skillnet cloudflared-skillnet && sudo systemctl restart skillnet && sudo systemctl start cloudflared-skillnet && sleep 1 && curl -fsS -o /dev/null -w "local %{http_code}\n" http://127.0.0.1:8795/.well-known/oauth-authorization-server'
curl -fsS -o /dev/null -w "public %{http_code}\n" https://rucksackhq.com/.well-known/oauth-authorization-server
# Clear Cloudflare's copy of the old app.js/style.css (needs ~/.config/cf/creds.json).
[ -f ~/.config/cf/creds.json ] && python3 - <<'PY'
import json, urllib.request
c = json.load(open(__import__('os').path.expanduser('~/.config/cf/creds.json')))
H = {'X-Auth-Email': 'lance.johnson@groundworkpro.com', 'X-Auth-Key': c['CLOUDFLARE_API_KEY'], 'Content-Type': 'application/json'}
get = lambda u, d=None: json.load(urllib.request.urlopen(urllib.request.Request(u, data=d, headers=H, method='POST' if d else 'GET')))
z = get('https://api.cloudflare.com/client/v4/zones?name=rucksackhq.com')['result'][0]['id']
print('cache cleared', get(f'https://api.cloudflare.com/client/v4/zones/{z}/purge_cache', json.dumps({'hosts': ['rucksackhq.com']}).encode())['success'])
PY
