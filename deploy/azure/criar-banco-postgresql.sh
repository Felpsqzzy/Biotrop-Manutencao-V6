#!/usr/bin/env bash
# BIOTROP · Cria o banco PostgreSQL da plataforma no Azure (Flexible Server).
#
# Onde rodar: Azure Cloud Shell (portal.azure.com → ícone ">_" → Bash).
# Suba este arquivo pelo botão "Carregar/Baixar arquivos" do Cloud Shell e rode:
#
#   bash criar-banco-postgresql.sh
#
# Tudo tem valor padrão; para trocar, defina antes de rodar, por exemplo:
#   IP_DA_VM=20.10.30.40 NOME_SERVIDOR=psql-biotrop-prod bash criar-banco-postgresql.sh
#
# Ao final grava ./biotrop-banco.env com as linhas prontas para o .env da VM
# (senhas geradas aqui, certificado SSL incluído). Guarde esse arquivo com cuidado.
set -euo pipefail

GRUPO="${GRUPO:-rg-biotrop-manutencao}"
REGIAO="${REGIAO:-brazilsouth}"
NOME_SERVIDOR="${NOME_SERVIDOR:-psql-biotrop-manutencao}"   # único no Azure inteiro
ADMIN_USUARIO="${ADMIN_USUARIO:-biotropadmin}"
BANCO="${BANCO:-biotrop}"
VERSAO_PG="${VERSAO_PG:-16}"
SKU="${SKU:-Standard_B1ms}"          # 1 vCPU / 2 GB: suficiente para a manutenção; suba para Standard_B2s se precisar
CAMADA="${CAMADA:-Burstable}"
DISCO_GB="${DISCO_GB:-32}"
BACKUP_DIAS="${BACKUP_DIAS:-14}"
IP_DA_VM="${IP_DA_VM:-}"             # IP público da VM que roda o site (libera só ela no firewall)
SAIDA="${SAIDA:-./biotrop-banco.env}"

senha() { echo "$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 30)Aa9"; }
passo() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

command -v az >/dev/null || { echo "Azure CLI não encontrado. Rode no Azure Cloud Shell."; exit 1; }
az account show --query "{assinatura:name, id:id}" -o table
read -r -p "Criar o banco nesta assinatura? [s/N] " ok; [[ "$ok" =~ ^[sS]$ ]] || exit 1

if [[ -z "$IP_DA_VM" ]]; then
  read -r -p "IP público da VM do site (Enter para liberar depois): " IP_DA_VM
fi

ADMIN_SENHA="$(senha)"; APP_SENHA="$(senha)"; WORKER_SENHA="$(senha)"

passo "Grupo de recursos $GRUPO ($REGIAO)"
az group create --name "$GRUPO" --location "$REGIAO" -o none

passo "Servidor PostgreSQL $VERSAO_PG ($SKU, $DISCO_GB GB, backup $BACKUP_DIAS dias) — leva de 5 a 10 minutos"
az postgres flexible-server create \
  --resource-group "$GRUPO" --name "$NOME_SERVIDOR" --location "$REGIAO" \
  --version "$VERSAO_PG" --tier "$CAMADA" --sku-name "$SKU" --storage-size "$DISCO_GB" \
  --backup-retention "$BACKUP_DIAS" \
  --admin-user "$ADMIN_USUARIO" --admin-password "$ADMIN_SENHA" \
  --public-access None --yes -o none

passo "Extensões usadas pelas migrations (pgcrypto, citext, pg_trgm, unaccent)"
az postgres flexible-server parameter set --resource-group "$GRUPO" --server-name "$NOME_SERVIDOR" \
  --name azure.extensions --value "PGCRYPTO,CITEXT,PG_TRGM,UNACCENT" -o none

passo "SSL obrigatório (TLS 1.2+)"
az postgres flexible-server parameter set --resource-group "$GRUPO" --server-name "$NOME_SERVIDOR" \
  --name require_secure_transport --value on -o none
az postgres flexible-server parameter set --resource-group "$GRUPO" --server-name "$NOME_SERVIDOR" \
  --name ssl_min_protocol_version --value TLSv1.2 -o none

passo "Banco $BANCO"
az postgres flexible-server db create --resource-group "$GRUPO" --server-name "$NOME_SERVIDOR" \
  --database-name "$BANCO" -o none

if [[ -n "$IP_DA_VM" ]]; then
  passo "Firewall: libera só a VM ($IP_DA_VM)"
  az postgres flexible-server firewall-rule create --resource-group "$GRUPO" --name "$NOME_SERVIDOR" \
    --rule-name vm-site --start-ip-address "$IP_DA_VM" --end-ip-address "$IP_DA_VM" -o none
else
  echo "Firewall sem regra: libere depois em Portal → servidor → Rede, ou rode:"
  echo "  az postgres flexible-server firewall-rule create -g $GRUPO -n $NOME_SERVIDOR --rule-name vm-site --start-ip-address IP --end-ip-address IP"
fi

HOST="$(az postgres flexible-server show --resource-group "$GRUPO" --name "$NOME_SERVIDOR" --query fullyQualifiedDomainName -o tsv)"

passo "Certificados raiz do Azure Database for PostgreSQL"
TMP="$(mktemp -d)"
curl -fsSL "https://cacerts.digicert.com/DigiCertGlobalRootG2.crt.pem" -o "$TMP/g2.pem"
curl -fsSL "https://cacerts.digicert.com/DigiCertGlobalRootCA.crt" -o "$TMP/g1.der"
curl -fsSL "https://www.microsoft.com/pkiops/certs/Microsoft%20RSA%20Root%20Certificate%20Authority%202017.crt" -o "$TMP/ms.der"
{ cat "$TMP/g2.pem"; openssl x509 -inform DER -in "$TMP/g1.der"; openssl x509 -inform DER -in "$TMP/ms.der"; } > azure-postgres-ca.pem
CA_UMA_LINHA="$(awk 'BEGIN{ORS="\\n"} {print}' azure-postgres-ca.pem)"

passo "Gravando $SAIDA"
umask 077
cat > "$SAIDA" <<EOF
# ===== Banco BIOTROP no Azure — gerado em $(date '+%d/%m/%Y %H:%M') =====
# Copie estas linhas para o .env da VM (substituindo as de banco). Não versione este arquivo.
DATABASE_URL=postgresql://biotrop_app:${APP_SENHA}@${HOST}:5432/${BANCO}
DATABASE_ADMIN_URL=postgresql://${ADMIN_USUARIO}:${ADMIN_SENHA}@${HOST}:5432/${BANCO}
DATABASE_WORKER_URL=postgresql://biotrop_worker:${WORKER_SENHA}@${HOST}:5432/${BANCO}
APP_DB_PASSWORD=${APP_SENHA}
WORKER_DB_PASSWORD=${WORKER_SENHA}
DATABASE_SSL=true
DATABASE_SSL_CA="${CA_UMA_LINHA}"
EOF
rm -rf "$TMP"

cat <<EOF

Pronto.
  Servidor: $HOST
  Banco:    $BANCO
  Arquivo:  $SAIDA   (baixe pelo Cloud Shell e apague daqui depois)

Próximos passos na VM (pasta /opt/biotrop):
  1. Cole o conteúdo de $SAIDA no .env (e no .env.app, só DATABASE_URL/DATABASE_SSL/DATABASE_SSL_CA).
  2. Crie o schema e as roles:     docker compose run --rm migrate      (ou: npm run db:migrate)
  3. Confira:                      npm run db:check
  4. Suba o site:                  docker compose up -d app worker
O primeiro acesso é de felipe.vieira@biotrop.com.br (admin, já liberado na migration 01).
EOF
