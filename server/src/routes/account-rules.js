// Regras de Minha conta, sem dependência de banco (usadas pela rota e pelos testes).
const TEMAS = new Set(['claro', 'escuro', 'sistema']);
const PREFS = {
  nome_exibicao: v => typeof v === 'string' && v.trim().length <= 80 ? v.trim() : undefined,
  escala: v => [90, 100, 112, 125, 140].includes(Number(v)) ? Number(v) : undefined,
  contraste: v => typeof v === 'boolean' ? v : undefined,
  movimento_reduzido: v => typeof v === 'boolean' ? v : undefined,
  sem_transparencia: v => typeof v === 'boolean' ? v : undefined,
  sublinhar_links: v => typeof v === 'boolean' ? v : undefined,
  foco_destacado: v => typeof v === 'boolean' ? v : undefined,
  fonte_leitura: v => typeof v === 'boolean' ? v : undefined,
  espacamento: v => typeof v === 'boolean' ? v : undefined,
  tema_manual: v => typeof v === 'boolean' ? v : undefined
};

function cleanPrefs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [key, check] of Object.entries(PREFS)) {
    if (!(key in input)) continue;
    const value = check(input[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const { normalizar: normalizarTelefone } = require('../lib/telefone');

function validate(body) {
  const errors = [];
  let foto = null, limparFoto = false;
  if (body.foto === null) limparFoto = true;
  else if (body.foto !== undefined) {
    const f = String(body.foto);
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f)) errors.push('Foto em formato inválido.');
    else if (f.length > 400000) errors.push('Foto grande demais (máximo ~300 KB).');
    else foto = f;
  }
  let telefone = null;
  if (body.telefone !== undefined) {
    // Um formato só para todo mundo: +55 (41) 9 9999-9999 [· ramal 1234]. O texto vem da tela, mas é normalizado aqui.
    const t = normalizarTelefone(body.telefone);
    if (!t.ok) errors.push(t.erro); else telefone = t.valor;
  }
  const tema = body.tema === undefined ? null : String(body.tema);
  if (tema !== null && !TEMAS.has(tema)) errors.push('Tema inválido.');
  const notificacoes = typeof body.notificacoes === 'boolean' ? body.notificacoes : null;
  const preferencias = body.preferencias === undefined ? null : cleanPrefs(body.preferencias);
  if (body.preferencias !== undefined && !preferencias) errors.push('Preferências inválidas.');
  return { errors, values: [foto, limparFoto, telefone, tema, notificacoes, preferencias ? JSON.stringify(preferencias) : null] };
}

module.exports = { validate, cleanPrefs };
