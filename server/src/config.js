const path = require('node:path');
const dotenv = require('dotenv');

// Em produção as variáveis vêm do orquestrador/EnvironmentFile específico do
// serviço. Não carregar o .env completo evita importar segredos de admin/worker.
if (process.env.NODE_ENV !== 'production') dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function boolean(name, fallback = false) {
  const raw = process.env[name];
  return raw == null ? fallback : String(raw).toLowerCase() === 'true';
}

function inteiro(name, fallback, min, max) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} deve estar entre ${min} e ${max}.`);
  return n;
}

const production = process.env.NODE_ENV === 'production';

/** Segredo forte: em produção recusa valor curto ou o texto de exemplo do .env.example. */
function secret(name, { optional = false } = {}) {
  const value = String(process.env[name] || '').trim();
  if (!value && optional) return '';
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  if (production && (value.length < 32 || /ALTERE/i.test(value))) {
    throw new Error(`${name} fraco ou de exemplo: gere com "openssl rand -base64 48".`);
  }
  return value;
}

/** Regras que NÃO podem ser afrouxadas em produção (falham na inicialização em vez de rodar inseguro). */
function exigirEmProducao() {
  if (!production) return;
  if (process.env.COOKIE_SECURE != null && String(process.env.COOKIE_SECURE).toLowerCase() !== 'true') {
    throw new Error('COOKIE_SECURE não pode ser desligado em produção.');
  }
  if (String(process.env.DATABASE_SSL || '').toLowerCase() !== 'true') throw new Error('Produção exige DATABASE_SSL=true (TLS até o PostgreSQL).');
  if (!String(process.env.DATABASE_SSL_CA || '').trim()) throw new Error('Produção exige DATABASE_SSL_CA (verificação do certificado do banco).');
  if (/[?&]sslmode=/i.test(String(process.env.DATABASE_URL || ''))) throw new Error('Remova sslmode de DATABASE_URL: o TLS é configurado por DATABASE_SSL/DATABASE_SSL_CA.');
  if (String(process.env.KMS_PROVEDOR || '').toLowerCase() !== 'azure') throw new Error('Produção exige KMS_PROVEDOR=azure (Azure Key Vault).');
  if (String(process.env.BIOMANUT_KEK_LOCAL || '').trim()) throw new Error('BIOMANUT_KEK_LOCAL é proibida em produção: remova-a do ambiente.');
  if (!/^https:\/\//.test(String(process.env.APP_BASE_URL || ''))) throw new Error('APP_BASE_URL precisa ser https:// em produção.');
  if (process.env.TWOFA_KEY && process.env.TWOFA_KEY === process.env.SESSION_SECRET) throw new Error('TWOFA_KEY deve ser diferente de SESSION_SECRET.');
}
exigirEmProducao();

module.exports = Object.freeze({
  production,
  host: String(process.env.HOST || '127.0.0.1'),
  port: Number(process.env.PORT || 3000),
  appBaseUrl: required('APP_BASE_URL').replace(/\/$/, ''),
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: boolean('DATABASE_SSL', false),
  databaseSslCa: String(process.env.DATABASE_SSL_CA || ''),
  poolMax: Number(process.env.DB_POOL_MAX || 20),
  sessionSecret: secret('SESSION_SECRET'),
  // Chave legada do 2FA (segredos no formato v1, códigos de recuperação e confirmação recente).
  // Sem ela, usa a de sessão — trocar a de sessão, nesse caso, invalidaria o 2FA de todos.
  twofaKey: secret('TWOFA_KEY', { optional: true }) || secret('SESSION_SECRET'),
  sessionHours: inteiro('SESSION_HOURS', 10, 1, 12),                  // validade absoluta
  sessionIdleMinutes: inteiro('SESSION_IDLE_MINUTES', 60, 5, 240),    // expira por inatividade
  // Terminal do almoxarifado: custo do scrypt da senha (N = 2^valor). Produção nunca abaixo de 2^17 (falha na
  // inicialização); fora dela os testes baixam para rodar rápido. O hash guarda o N usado: trocar não invalida senhas
  // (cada uma é regravada no próximo login certo). Enquanto houver hash com o custo antigo, todo login calcula os dois
  // custos (tempo igual para quem existe e quem não existe; lib/senha-terminal.js) — fica mais lento até a migração
  // acabar. Para encerrá-la, gere convite de redefinição para quem não entrou depois da troca.
  terminalScryptLog2N: inteiro('TERMINAL_SCRYPT_LOG2N', 17, production ? 17 : 12, 20),
  cookieSecure: production ? true : boolean('COOKIE_SECURE', false),
  trustProxy: Number(process.env.TRUST_PROXY || 1),
  // Pasta do front (build do Vite). Em produção é sempre apps/web/dist; fora dela os testes apontam para uma pasta de exemplo.
  webDir: path.resolve((!production && process.env.WEB_DIR) || path.resolve(__dirname, '..', '..', 'apps', 'web', 'dist')),
  entraTenantId: required('ENTRA_TENANT_ID'),
  entraClientId: required('ENTRA_CLIENT_ID'),
  entraClientSecret: production && /ALTERE/i.test(String(process.env.ENTRA_CLIENT_SECRET || '')) ? secret('ENTRA_CLIENT_SECRET') : required('ENTRA_CLIENT_SECRET'),
  // Criptografia de dados armazenados (envelope): KEK no Azure Key Vault, DEKs no banco embrulhadas.
  kmsProvedor: String(process.env.KMS_PROVEDOR || (production ? 'azure' : 'local')).toLowerCase(),
  azureKeyVaultKeyId: String(process.env.AZURE_KEYVAULT_KEY_ID || '').trim(),
  kekLocal: production ? '' : String(process.env.BIOMANUT_KEK_LOCAL || '').trim(),
  criptoInquilino: String(process.env.CRIPTO_INQUILINO || 'biotrop').trim(),
  // Copiloto BIOMANUT (rota /api/copiloto): chave da API do Claude, só no servidor. Sem ela o copiloto fica desligado (as demais telas não mudam).
  copilotoChave: String(process.env.ANTHROPIC_API_KEY || '').trim(),
  copilotoModelo: String(process.env.COPILOTO_MODELO || 'claude-sonnet-5-5').trim(),
  copilotoLimiteDia: inteiro('COPILOTO_LIMITE_DIA', 200, 1, 5000)   // perguntas por pessoa por dia
});
