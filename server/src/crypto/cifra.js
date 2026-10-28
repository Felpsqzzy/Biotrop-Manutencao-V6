'use strict';
// Serviço de cifragem de dados armazenados: AES-256-GCM (Node/OpenSSL), chave de 256 bits, nonce de 96 bits
// aleatório (CSPRNG) e tag de 128 bits. O contexto autenticado (AAD) vincula o dado ao inquilino, recurso,
// registro, campo, finalidade e versão do registro — valores do SERVIDOR, nunca do cliente.
// O texto só é devolvido depois que a tag confere (decipher.final() lança antes, em caso de adulteração).
const crypto = require('node:crypto');
const F = require('./formato');

function criarServicoCifra({ chaveiro, inquilino }) {
  if (!inquilino) throw new F.ErroCifra('CONFIG', 'Inquilino da cifragem não configurado.');

  function contexto(ctx) {
    for (const k of ['recurso', 'registro', 'campo', 'finalidade']) if (!ctx || !ctx[k]) throw new F.ErroCifra('CONTEXTO_INCOMPLETO', `Contexto sem "${k}".`);
    return { inquilino, recurso: ctx.recurso, registro: ctx.registro, campo: ctx.campo, finalidade: ctx.finalidade, versao: ctx.versao ?? '' };
  }

  async function cifrar(ctx, dados) {
    const c = contexto(ctx);
    const claro = Buffer.isBuffer(dados) ? dados : Buffer.from(String(dados), 'utf8');
    const { dekId, chave } = await chaveiro.paraCifrar(c.finalidade);
    const cab = F.cabecalho(dekId);
    const nonce = crypto.randomBytes(F.TAM_NONCE);
    const cipher = crypto.createCipheriv('aes-256-gcm', chave, nonce, { authTagLength: F.TAM_TAG });
    cipher.setAAD(F.contextoAAD(c, cab));
    const ct = Buffer.concat([cipher.update(claro), cipher.final()]);
    return F.empacotar(cab, nonce, ct, cipher.getAuthTag());
  }

  async function decifrar(ctx, texto) {
    const c = contexto(ctx);
    const p = F.desempacotar(texto);
    const chave = await chaveiro.paraDecifrar(p.dekId, c.finalidade);
    const d = crypto.createDecipheriv('aes-256-gcm', chave, p.nonce, { authTagLength: F.TAM_TAG });
    d.setAAD(F.contextoAAD(c, p.cabecalho));
    d.setAuthTag(p.tag);
    try { return Buffer.concat([d.update(p.ciphertext), d.final()]); }
    catch { throw new F.ErroCifra('AUTENTICACAO', 'Dado cifrado adulterado, truncado ou fora do contexto.'); }
  }

  return {
    cifrar,
    decifrar,
    async cifrarTexto(ctx, s) { return cifrar(ctx, Buffer.from(String(s), 'utf8')); },
    async decifrarTexto(ctx, t) { return (await decifrar(ctx, t)).toString('utf8'); },
    async cifrarJSON(ctx, v) { return cifrar(ctx, Buffer.from(JSON.stringify(v), 'utf8')); },
    async decifrarJSON(ctx, t) { return JSON.parse((await decifrar(ctx, t)).toString('utf8')); },
    ehCifrado: F.ehCifrado
  };
}

module.exports = { criarServicoCifra };
