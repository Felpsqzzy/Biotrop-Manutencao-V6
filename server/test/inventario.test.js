'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decimal, report } = require('../src/lib/inventario');
test('inventário: decimais exatos, limite numeric20,6 e zero não confunde preço ausente', () => {
  assert.equal(decimal('99999999999999.999999'), '99999999999999.999999');
  assert.equal(decimal('0'), '0.000000');
  assert.equal(decimal('-0.000001'), '-0.000001');
  for (const x of ['1e2', 'NaN', '1.0000001', '100000000000000', '1,2', '', Infinity]) assert.throws(() => decimal(x));
  assert.throws(() => decimal('-1', false));
});
const row = (saldo, quantidadeFinal, precoUnitario, extra = {}) => ({ unidade: 'UN', saldo, quantidadeFinal, precoUnitario, ...extra });
test('inventário: perdas e sobras separadas, ajuste exato e acuracidade com cobertura explícita', () => {
  const r = report([row('10','9','0.1',{contagens:[{quantidade:'8'}]}), row('10','12','0.2',{contagens:[{quantidade:'12'}]}), row('3','3','0',{contagens:[{quantidade:'3'}]})]);
  assert.equal(r.perdas, '0.100000'); assert.equal(r.sobras, '0.400000'); assert.equal(r.ajuste, '0.300000');
  assert.equal(r.valorReferencia, '3.000000'); assert.equal(r.valorContado, '3.300000');
  assert.equal(r.acuracidadeItensLocalizacoes, '33.333333'); assert.equal(r.acuracidadePrimeiraContagem,'33.333333');
  const partial=report([row('1','1','1'),row('2',null,'1')]);
  assert.equal(partial.acuracidadeItensLocalizacoes,'100.000000'); assert.equal(partial.cobertura,'50.000000');
  assert.equal(partial.ajuste,null);
});
test('inventário: ausência de custo/unidade bloqueia financeiro e precisão não usa ponto flutuante', () => {
  assert.equal(report([row('1','1',null)]).valorizacaoCompleta,false);
  assert.equal(report([row('1','1','1',{unidade:''})]).ajuste,null);
  const large=report([row('99999999999999.999998','99999999999999.999999','99999999999999.999999')]);
  assert.equal(large.ajuste,'100000000.000000');
  assert.equal(report([row('0','0.000001','0.500000')]).ajuste,'0.000001');
});
test('inventário: faltas e sobras que se anulam no líquido continuam no absoluto (teste fictício)', () => {
  const r = report([row('10', '8', '10', { codigo: 'A', camm: 'C1' }), row('10', '12', '10', { codigo: 'B', camm: 'C2' })]);
  assert.equal(r.ajuste, '0.000000'); assert.equal(r.absoluto, '40.000000');
  assert.equal(r.valoresParciais.faltas, '-20.000000'); assert.equal(r.valoresParciais.sobras, '20.000000');
  assert.equal(r.valoresParciais.liquido, '0.000000'); assert.equal(r.valoresParciais.absoluto, '40.000000');
  assert.equal(r.valoresParciais.divergenciaPercentual, '20.000000');
  assert.deepEqual(r.grupos.camm.map(g => [g.chave, g.faltas, g.sobras]), [['C1', '-20.000000', '0.000000'], ['C2', '0.000000', '20.000000']]);
  assert.equal(r.divergentes, 2); assert.equal(r.maioresDivergencias.length, 2);
});
test('inventário: custo parcial mostra cobertura, sem custo zero fictício; base zero é não aplicável', () => {
  const r = report([row('10', '9', '2', { codigo: 'A' }), row('5', '5', null, { codigo: 'B' }), row('3', null, '1', { codigo: 'C' })]);
  assert.equal(r.ajuste, null, 'total oficial só com valorização completa');
  assert.equal(r.valoresParciais.posicoes, 1); assert.equal(r.valoresParciais.cobertura, '50.000000');
  assert.equal(r.valoresParciais.faltas, '-2.000000');
  assert.equal(r.codigosDistintos, 3); assert.equal(r.codigosConcluidos, 2);
  assert.equal(report([]).cobertura, null); assert.equal(report([]).acuracidadeItensLocalizacoes, null);
  assert.equal(report([row('0', '1', '0')]).valoresParciais.divergenciaPercentual, null);
});
test('inventário: fração preservada e unidades nunca somadas entre si (teste fictício)', () => {
  const r = report([row('0.50', '0.75', null, { unidade: 'MT', codigo: 'A' }), row('2', '1', null, { unidade: 'UN', codigo: 'B' }), row('3', '4', null, { unidade: 'UN', codigo: 'C' })]);
  assert.equal(r.linhas[0].diferenca, '0.250000');
  const un = Object.fromEntries(r.unidades.map(u => [u.unidade, u]));
  assert.equal(un.MT.sobras, '0.250000'); assert.equal(un.UN.faltas, '1.000000'); assert.equal(un.UN.sobras, '1.000000');
  assert.equal(r.grupos.camm[0].chave, 'Sem CAMM');
});
