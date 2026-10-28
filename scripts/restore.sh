#!/usr/bin/env bash
# Restaura um backup cifrado (.dump.age). A chave PRIVADA não fica na VM: informe o arquivo dela só na hora
# (BACKUP_AGE_IDENTITY=/caminho/biotrop-backup.key) e apague a cópia depois.
set -euo pipefail
if [[ $# -ne 1 ]]; then echo "Uso: BACKUP_AGE_IDENTITY=chave.key $0 /caminho/biotrop-AAAA.dump.age"; exit 2; fi
test -f "$1"
: "${DATABASE_ADMIN_URL:?defina DATABASE_ADMIN_URL}"
if [[ -f "$1.sha256" ]]; then sha256sum -c "$1.sha256"; fi
echo "ATENCAO: a restauracao substitui objetos do banco informado em DATABASE_ADMIN_URL."
case "$1" in
  *.age)
    : "${BACKUP_AGE_IDENTITY:?informe BACKUP_AGE_IDENTITY (chave privada do backup)}"
    age --decrypt --identity "$BACKUP_AGE_IDENTITY" "$1" | pg_restore --dbname "$DATABASE_ADMIN_URL" --clean --if-exists --no-owner ;;
  *) pg_restore --dbname "$DATABASE_ADMIN_URL" --clean --if-exists --no-owner "$1" ;;
esac
