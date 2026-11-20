#!/bin/sh
# Deploy to the Skillnet server: ./deploy/deploy.sh   (ssh alias skillnet = ubuntu@135.148.170.44)
set -e
cd "$(dirname "$0")/.."
H=${SKILLNET_HOST:-skillnet}
npm test >/dev/null
rsync -az --delete --rsync-path='sudo rsync' --exclude .git --exclude data --exclude node_modules ./ "$H:/opt/skillnet/"
ssh "$H" 'sudo cp /opt/skillnet/deploy/*.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable -q skillnet cloudflared-skillnet && sudo systemctl restart skillnet && sudo systemctl start cloudflared-skillnet && sleep 1 && curl -fsS -o /dev/null -w "local %{http_code}\n" http://127.0.0.1:8795/.well-known/oauth-authorization-server'
curl -fsS -o /dev/null -w "public %{http_code}\n" https://skillnet.lancejohnson.com/.well-known/oauth-authorization-server
