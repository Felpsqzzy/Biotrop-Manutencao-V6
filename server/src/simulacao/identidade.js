'use strict';
// Identidade do MODO DE TESTE (simulação de vários usuários ao mesmo tempo, só para o admin).
//   • usuários virtuais: e-mail no domínio reservado abaixo (não existe; nunca entra pela Microsoft — auth.js recusa);
//   • registros que eles criam: payload._simulacao = true e id começando com "SIM-".
// Ninguém além do admin (e dos próprios usuários virtuais) vê esses registros: read-scope.js filtra.
const DOMINIO = 'simulacao.biomanut.local';
const PREFIXO = 'SIM-';

const ehSimulado = user => String(user?.email || '').toLowerCase().endsWith('@' + DOMINIO);
/** Quem enxerga os dados da simulação: o admin (que acompanha o teste) e os próprios usuários virtuais. */
const vePlanoDeTeste = user => user?.perfilId === 'admin' || ehSimulado(user);

module.exports = { DOMINIO, PREFIXO, ehSimulado, vePlanoDeTeste };
