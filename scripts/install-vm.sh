#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo "Execute com sudo."; exit 1; fi
id biotrop >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/biotrop --shell /bin/bash biotrop
install -d -o biotrop -g biotrop -m 750 /opt/biotrop /opt/biotrop/logs
install -d -o biotrop -g biotrop -m 700 /opt/biotrop/backups
echo "Usuário e diretórios criados. Copie o projeto para /opt/biotrop e siga docs/DEPLOY-TI.md."
