#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "${BIOTROP_ROOT:-/opt/biotrop}"
test -f .env
install -d -m 700 backups

echo "1/5 · Backup"
: "${BACKUP_AGE_RECIPIENT:?defina BACKUP_AGE_RECIPIENT (chave pública age): backup em claro não é permitido}"
docker compose exec -T postgres pg_dump -U postgres -d biotrop -Fc | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).dump.age"

echo "2/5 · Atualização do código"
git pull --ff-only

echo "3/5 · Build"
docker compose build app migrate email-worker

echo "4/5 · Migrations"
docker compose run --rm migrate

echo "5/5 · Reinício e saúde"
docker compose up -d app email-worker
sleep 3
curl -fsS http://127.0.0.1:3000/health
echo
echo "Deploy concluído."
