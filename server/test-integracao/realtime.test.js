'use strict';
// Tempo real: uma conexão SSE por pessoa para vários módulos, com o escopo de leitura de cada um.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h;
test.before(async () => { h = await subirApp({ tec: 'tecnico', tec2: 'tecnico', almox: 'almoxarife' }); });
test.after(() => h?.fechar());

const { createSession } = require('../src/auth/session');
/** Abre o SSE e junta os eventos "change" por até `ms`. */
function ouvir(u, ns, ms) {
  const ctl = new AbortController(), eventos = [];
  const pronto = fetch(`${h.raiz}/api/realtime?namespaces=${ns}`, { signal: ctl.signal, headers: { cookie: `biotrop_session=${createSession({ id: u.id, sessaoVersao: u.sv }).valor}` } })
    .then(async r => {
      assert.equal(r.status, 200);
      const leitor = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await leitor.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloco = buf.slice(0, i); buf = buf.slice(i + 2);
          const tipo = /event: (\w+)/.exec(bloco)?.[1], dado = /data: (.*)/.exec(bloco)?.[1];
          if (tipo === 'change') eventos.push(JSON.parse(dado));
        }
      }
    }).catch(e => { if (e.name !== 'AbortError') throw e; });
  return { eventos, fim: () => new Promise(r => setTimeout(() => { ctl.abort(); pronto.then(() => r(eventos)); }, ms)) };
}

test('uma conexão para vários módulos; a mudança chega para quem pode ver e não chega para quem não pode', async () => {
  const almox = ouvir(h.users.almox, 'sci,scm,utility_readings', 9000);
  const outro = ouvir(h.users.tec2, 'sci,scm', 9000);
  await new Promise(r => setTimeout(r, 600));
  const id = 'sci-rt-1';
  const r = await h.api(h.users.tec, 'PUT', `/api/data/sci/${id}`, { expectedVersion: 0, payload: { id, solicitanteId: h.users.tec.id, status: 'pendente', familiaId: 'outros', observacoes: 'detalhe sensível' } });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const [ea, eo] = await Promise.all([almox.fim(), outro.fim()]);
  const chegou = ea.find(e => e.recordId === id);
  assert.ok(chegou, 'almoxarifado recebeu a SCI nova em tempo real');
  assert.equal(chegou.namespace, 'sci');
  assert.equal(chegou.payload.observacoes, 'detalhe sensível', 'chega decifrada, como em /api/data');
  assert.ok(!eo.some(e => e.recordId === id), 'outro técnico não recebe a SCI de colega');
});

test('módulo inválido é recusado', async () => {
  const r = await fetch(`${h.raiz}/api/realtime?namespaces=sci,senhas`, { headers: { cookie: `biotrop_session=${createSession({ id: h.users.tec.id, sessaoVersao: h.users.tec.sv }).valor}` } });
  assert.equal(r.status, 400);
});
