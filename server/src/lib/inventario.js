(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BiotropInventario = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Mesmo arquivo em server/src/lib/inventario.js e web/src/almox/inventario-calculo.js (teste confere que são iguais).
  const SCALE = 1000000n;
  function fixed(value, signed = true) {
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Informe o número como texto decimal.');
    const text = String(value).trim();
    if (!/^-?\d{1,14}(?:\.\d{1,6})?$/.test(text)) throw new Error('Número inválido: máximo 14 inteiros e 6 decimais, com ponto decimal.');
    const neg = text.startsWith('-');
    if (neg && !signed) throw new Error('A quantidade contada e o preço não podem ser negativos.');
    const [whole, fraction = ''] = (neg ? text.slice(1) : text).split('.');
    return (BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'))) * (neg ? -1n : 1n);
  }
  function format(value) {
    const n = BigInt(value), a = n < 0n ? -n : n;
    return `${n < 0n ? '-' : ''}${a / SCALE}.${String(a % SCALE).padStart(6, '0')}`;
  }
  function decimal(value, signed = true) { return format(fixed(value, signed)); }
  // Produtos são acumulados com 12 casas; só o total final é arredondado para 6 casas.
  function rounded(value, divisor) { const neg = value < 0n, a = neg ? -value : value; return (a / divisor + (a % divisor * 2n >= divisor ? 1n : 0n)) * (neg ? -1n : 1n); }
  const pct = (num, den) => den > 0n ? format(rounded(num * 100n * SCALE, den)) : null;
  const money = v => format(rounded(v, SCALE));
  function bucket() { return { posicoes: 0, completas: 0, divergentes: 0, valorizadas: 0, perdas: 0n, sobras: 0n, referencia: 0n }; }
  function closeBucket(chave, b) {
    return { chave, posicoes: b.posicoes, completas: b.completas, divergentes: b.divergentes, valorizadas: b.valorizadas,
      faltas: money(-b.perdas), sobras: money(b.sobras), liquido: money(b.sobras - b.perdas), absoluto: money(b.sobras + b.perdas),
      valorReferencia: money(b.referencia) };
  }
  function report(rows) {
    let perdas = 0n, sobras = 0n, referencia = 0n, contado = 0n, iguais = 0, primeiras = 0, primeirasIguais = 0, valorizadas = 0;
    const grupos = { camm: new Map(), site: new Map(), deposito: new Map() };
    const unidades = new Map(), codigos = new Set(), codigosConcluidos = new Set();
    const linhas = rows.map(row => {
      const saldo = fixed(String(row.saldo)), quantidade = row.quantidadeFinal == null ? null : fixed(String(row.quantidadeFinal), false);
      const preco = row.precoUnitario == null ? null : fixed(String(row.precoUnitario), false);
      const diferenca = quantidade == null ? null : quantidade - saldo;
      codigos.add(row.codigo);
      if (quantidade != null) codigosConcluidos.add(row.codigo);
      if (diferenca === 0n) iguais++;
      if (row.contagens?.length) {
        primeiras++;
        if (fixed(String(row.contagens[0].quantidade), false) === saldo) primeirasIguais++;
      }
      const valorado = preco !== null && diferenca !== null;
      if (valorado) {
        valorizadas++;
        referencia += saldo * preco; contado += quantidade * preco;
        if (diferenca < 0n) perdas += -diferenca * preco; else sobras += diferenca * preco;
      }
      for (const [k, m] of Object.entries(grupos)) {
        const chave = String(row[k] || '').trim() || (k === 'camm' ? 'Sem CAMM' : '(vazio)');
        if (!m.has(chave)) m.set(chave, bucket());
        const b = m.get(chave);
        b.posicoes++;
        if (quantidade != null) b.completas++;
        if (diferenca != null && diferenca !== 0n) b.divergentes++;
        if (valorado) { b.valorizadas++; b.referencia += saldo * preco; if (diferenca < 0n) b.perdas += -diferenca * preco; else b.sobras += diferenca * preco; }
      }
      // quantidades só se somam dentro da mesma unidade (UN, MT e L nunca no mesmo total)
      const un = String(row.unidade || '').trim() || '(sem unidade)';
      if (!unidades.has(un)) unidades.set(un, { unidade: un, posicoes: 0, completas: 0, divergentes: 0, faltas: 0n, sobras: 0n });
      const u = unidades.get(un); u.posicoes++;
      if (quantidade != null) u.completas++;
      if (diferenca != null && diferenca !== 0n) { u.divergentes++; if (diferenca < 0n) u.faltas += -diferenca; else u.sobras += diferenca; }
      return { ...row, saldo: format(saldo), quantidadeFinal: quantidade == null ? null : format(quantidade),
        precoUnitario: preco == null ? null : format(preco), diferenca: diferenca == null ? null : format(diferenca),
        ajusteValor: valorado ? format(rounded(diferenca * preco, SCALE)) : null };
    });
    const completas = linhas.filter(x => x.quantidadeFinal != null).length;
    const divergentes = linhas.filter(x => x.diferenca != null && fixed(x.diferenca) !== 0n).length;
    const valorizacaoCompleta = linhas.every(x => x.quantidadeFinal != null && x.precoUnitario != null && String(x.unidade || '').trim());
    const absoluto = sobras + perdas;
    const maiores = linhas.filter(x => x.diferenca != null && fixed(x.diferenca) !== 0n)
      .sort((a, b) => {
        const va = a.ajusteValor == null ? -1n : (fixed(a.ajusteValor) < 0n ? -fixed(a.ajusteValor) : fixed(a.ajusteValor));
        const vb = b.ajusteValor == null ? -1n : (fixed(b.ajusteValor) < 0n ? -fixed(b.ajusteValor) : fixed(b.ajusteValor));
        return vb > va ? 1 : vb < va ? -1 : 0;
      }).slice(0, 15);
    return { moeda: 'BRL', linhas, totalLinhas: linhas.length, completas, iguais, divergentes, pendentes: linhas.length - completas,
      codigosDistintos: codigos.size, codigosConcluidos: codigosConcluidos.size,
      semPreco: linhas.filter(x => x.precoUnitario == null).length, semUnidade: linhas.filter(x => !String(x.unidade || '').trim()).length,
      valorizacaoCompleta, acuracidadeItensLocalizacoes: pct(BigInt(iguais), BigInt(completas)),
      cobertura: pct(BigInt(completas), BigInt(linhas.length)),
      primeirasContagens: primeiras, primeirasIguais,
      acuracidadePrimeiraContagem: pct(BigInt(primeirasIguais), BigInt(primeiras)),
      precisao: { quantidade: 6, precoUnitario: 6, valor: 6, arredondamento: 'metade para longe de zero; produtos somados em 12 casas antes do arredondamento final' },
      perdas: valorizacaoCompleta ? money(perdas) : null,
      sobras: valorizacaoCompleta ? money(sobras) : null,
      ajuste: valorizacaoCompleta ? money(sobras - perdas) : null,
      absoluto: valorizacaoCompleta ? money(absoluto) : null,
      valorReferencia: valorizacaoCompleta ? money(referencia) : null,
      valorContado: valorizacaoCompleta ? money(contado) : null,
      // Mesmo com custo faltando em parte das posições: valores só das posições concluídas e valorizadas,
      // com a cobertura explícita. Faltas com sinal negativo, sobras positivo; o absoluto não se anula.
      valoresParciais: { posicoes: valorizadas, cobertura: pct(BigInt(valorizadas), BigInt(completas)),
        faltas: money(-perdas), sobras: money(sobras), liquido: money(sobras - perdas), absoluto: money(absoluto),
        valorReferencia: money(referencia), valorContado: money(contado),
        divergenciaPercentual: referencia > 0n ? format(rounded(absoluto * 100n * SCALE, referencia)) : null },
      grupos: Object.fromEntries(Object.entries(grupos).map(([k, m]) => [k, [...m].map(([chave, b]) => closeBucket(chave, b)).sort((a, b) => a.chave.localeCompare(b.chave))])),
      unidades: [...unidades.values()].map(u => ({ ...u, faltas: format(u.faltas), sobras: format(u.sobras) })).sort((a, b) => b.posicoes - a.posicoes),
      maioresDivergencias: maiores };
  }
  /**
   * Tabelas para o Power BI: uma linha por inventário, por posição e por contagem.
   * entradas: [{ campanha: {id,nome,estado,criado_em,criado_por,fechado_em,fechado_por,base_nome,data_referencia,data_exportacao,fonte}, itens }]
   */
  function biDataset(entradas, pessoas) {
    const nome = id => (pessoas && pessoas[id]) || '';
    const posicoes = [], contagens = [];
    const campanhas = entradas.map(({ campanha: c, itens }) => {
      const rel = report(itens);
      for (const l of rel.linhas) {
        const situacao = l.quantidadeFinal == null ? 'Pendente' : fixed(l.diferenca) !== 0n ? 'Divergente' : 'Conferido';
        posicoes.push({ campanhaId: c.id, campanha: c.nome, camm: l.camm || 'Sem CAMM', codigo: l.codigo, descricao: l.descricao, unidade: l.unidade,
          site: l.site, deposito: l.deposito, localizacao: l.localizacao, lote: l.lote || '', serie: l.serie || '', saldo: l.saldo, quantidadeFinal: l.quantidadeFinal,
          diferenca: l.diferenca, precoUnitario: l.precoUnitario, ajusteValor: l.ajusteValor, etapa: l.encerrado ? 'Concluída' : `${l.etapa}ª contagem`,
          situacao, justificativa: (l.justificativas || []).map(j => j.texto).join(' | ') });
        for (const x of l.contagens || []) contagens.push({ campanhaId: c.id, campanha: c.nome, camm: l.camm || 'Sem CAMM', codigo: l.codigo, localizacao: l.localizacao,
          etapa: x.etapa, quantidade: x.quantidade, igualAoSaldo: fixed(x.quantidade) === fixed(l.saldo) ? 'Sim' : 'Não', contador: nome(x.por), em: x.em });
      }
      const p = rel.valoresParciais;
      return { id: c.id, nome: c.nome, estado: c.estado === 'fechada' ? 'Aprovado' : rel.pendentes ? 'Em contagem' : 'Aguardando aprovação',
        base: c.base_nome || '', dataReferencia: c.data_referencia || null, dataExportacao: c.data_exportacao || null, fonte: c.fonte || '',
        criadoEm: c.criado_em, criadoPor: nome(c.criado_por), aprovadoEm: c.fechado_em || null, aprovadoPor: nome(c.fechado_por),
        posicoes: rel.totalLinhas, concluidas: rel.completas, divergentes: rel.divergentes, pendentes: rel.pendentes, codigosDistintos: rel.codigosDistintos,
        cobertura: rel.cobertura, acuracidade: rel.acuracidadeItensLocalizacoes, acuracidadePrimeiraContagem: rel.acuracidadePrimeiraContagem,
        posicoesValorizadas: p.posicoes, coberturaValorizacao: p.cobertura, faltas: p.faltas, sobras: p.sobras, liquido: p.liquido, absoluto: p.absoluto,
        valorReferencia: p.valorReferencia, valorContado: p.valorContado, divergenciaPercentual: p.divergenciaPercentual };
    });
    return { campanhas, posicoes, contagens };
  }
  return { fixed, format, decimal, report, biDataset };
});
