#!/usr/bin/env bash
# Backup do PostgreSQL CIFRADO na origem: o pg_dump sai direto para o `age` com a chave PÚBLICA do backup.
# Na VM fica só a chave pública (BACKUP_AGE_RECIPIENT="age1..."); a chave privada que abre o backup fica
# FORA da VM (cofre da TI / Key Vault / pendrive no cofre). Quem copiar a pasta de backups não consegue ler.
# Sem a chave pública configurada o script PARA — nunca grava backup em claro.
#   Gerar o par (uma vez, fora da VM):  age-keygen -o biotrop-backup.key   → mostra a "Public key: age1..."
#   Copiar para fora da VM (recomendado): BACKUP_DESTINO="azure-blob ou rclone remote" (ver docs/DEPLOY-TI.md)
set -euo pipefail
umask 077
ROOT="${BIOTROP_ROOT:-/opt/biotrop}"
BACKUP_DIR="${ROOT}/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
: "${DATABASE_ADMIN_URL:?defina DATABASE_ADMIN_URL}"
if [[ -z "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  echo "ERRO: BACKUP_AGE_RECIPIENT não definido (chave pública age). Backup em claro não é permitido." >&2; exit 3
fi
command -v age >/dev/null || { echo "ERRO: instale o age (apt install age)." >&2; exit 3; }
mkdir -p "$BACKUP_DIR"
ARQ="${BACKUP_DIR}/biotrop-${STAMP}.dump.age"
pg_dump "$DATABASE_ADMIN_URL" --format=custom --no-owner | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "${ARQ}.parcial"
mv "${ARQ}.parcial" "$ARQ"
sha256sum "$ARQ" > "${ARQ}.sha256"
# cópia fora da VM (opcional, mas recomendado): rclone para um container com imutabilidade/retenção
if [[ -n "${BACKUP_RCLONE_DESTINO:-}" ]]; then
  command -v rclone >/dev/null || { echo "ERRO: destino externo configurado mas rclone n�o est� instalado." >&2; exit 3; }
  rclone copy "$ARQ" "$BACKUP_RCLONE_DESTINO" && rclone copy "${ARQ}.sha256" "$BACKUP_RCLONE_DESTINO"
fi
find "$BACKUP_DIR" -type f \( -name 'biotrop-*.dump.age' -o -name 'biotrop-*.dump.age.sha256' \) -mtime +30 -delete
# backups antigos em claro (de antes desta versão) não ficam esquecidos na VM
find "$BACKUP_DIR" -type f -name '*.dump' -mtime +1 -print -delete | sed 's/^/Removido backup antigo sem cifra: /' || true
echo "Backup cifrado: $(basename "$ARQ")"
