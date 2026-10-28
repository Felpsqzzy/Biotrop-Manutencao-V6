'use strict';
// Almoxarifado · Catálogo de itens (~30 mil com código MAN): importação, busca, fotos e permissões — sob o RLS de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h;
test.before(async () => { h = await subirApp({ tec: 'tecnico', pcm: 'pcm', almox: 'almoxarife' }); });
test.after(() => h?.fechar());

const API = '/api/almox/materiais';
const jpeg = (tam = 400, x = 1) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(tam, x)]).toString('base64');

test('almoxarifado importa a planilha em partes e reimportar atualiza sem duplicar', async () => {
  const linhas = Array.from({ length: 3000 }, (_, i) => ({ codigo: `man${10000 + i}`, descricao: `Item genérico ${i}`, unidade: 'pç', grupo: i % 2 ? 'Fixação' : 'Elétrica' }));
  linhas[0] = { codigo: 'MAN8921', descricao: 'DIAFRAGMA DN-40 GEMÜ PTFE/EPDM', unidade: 'UN', grupo: 'Válvulas', marca: 'GEMÜ', localizacao: 'A-12-3' };
  linhas[1] = { codigo: 'MAN2089', descricao: 'Diafragma DN-50 válvula de água quente', grupo: 'Válvulas' };
  linhas.push({ codigo: 'código com espaço?', descricao: 'x' }, { codigo: 'MAN1', descricao: '' });
  let r = await h.api(h.users.almox, 'POST', `${API}/importar`, { linhas: linhas.slice(0, 2000), arquivo: 'estoque.xlsx', ultimaParte: false });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.novos, 2000);
  r = await h.api(h.users.almox, 'POST', `${API}/importar`, { linhas: linhas.slice(2000), arquivo: 'estoque.xlsx', totalLinhas: linhas.length, totalNovos: 2000 });
  assert.equal(r.j.novos, 1000);
  assert.equal(r.j.totalRecusadas, 2, 'código inválido e item sem descrição são recusados, com o motivo');
  assert.equal((await h.q('SELECT count(*)::int n FROM almox.material')).rows[0].n, 3000);
  assert.equal((await h.q("SELECT codigo FROM almox.material WHERE codigo='MAN10002'")).rows.length, 1, 'código vai em maiúsculas');
  r = await h.api(h.users.almox, 'POST', `${API}/importar`, { linhas: [{ codigo: 'MAN2089', descricao: 'Diafragma DN-50 água quente (revisado)', grupo: 'Válvulas' }] });
  assert.equal(r.j.novos, 0); assert.equal(r.j.atualizados, 1);
  assert.equal((await h.q("SELECT linhas, novos FROM almox.material_carga WHERE arquivo='estoque.xlsx'")).rows[0].novos, 3000, 'a importação fica registrada');
});

test('busca por nome sem acento, por pedaço de palavra e por código; filtro por grupo', async () => {
  let r = await h.api(h.users.tec, 'GET', `${API}?q=${encodeURIComponent('diafragma agua')}`);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.rows.map(x => x.codigo), ['MAN2089'], '"agua" acha "água"');
  r = await h.api(h.users.tec, 'GET', `${API}?q=diafr`);
  assert.equal(r.j.total, 2, 'começo da palavra basta');
  r = await h.api(h.users.tec, 'GET', `${API}?q=man8921`);
  assert.equal(r.j.rows[0].codigo, 'MAN8921', 'código exato vem primeiro');
  r = await h.api(h.users.pcm, 'GET', `${API}?q=${encodeURIComponent("'); DROP TABLE x; --")}`);
  assert.equal(r.s, 200, 'texto estranho na busca não vira SQL nem quebra a consulta');
  r = await h.api(h.users.tec, 'GET', `${API}?grupo=${encodeURIComponent('Válvulas')}`);
  assert.equal(r.j.total, 2);
  r = await h.api(h.users.tec, 'GET', `${API}?pagina=2&grupo=Fixação`);
  assert.equal(r.j.rows.length, 50); assert.equal(r.j.pagina, 2);
  r = await h.api(h.users.tec, 'GET', `${API}/resumo?codigos=MAN8921,MAN2089,NAOEXISTE`);
  assert.deepEqual(Object.keys(r.j.itens).sort(), ['MAN2089', 'MAN8921']);
});

test('fotos: só imagem de verdade, no banco, servida só para quem está logado', async () => {
  let r = await h.api(h.users.almox, 'POST', `${API}/MAN8921/fotos`, { imagem: 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>'.repeat(10)).toString('base64'), miniatura: jpeg(200) });
  assert.equal(r.s, 400, 'conteúdo que não é JPEG é recusado mesmo dizendo ser JPEG');
  r = await h.api(h.users.almox, 'POST', `${API}/MAN8921/fotos`, { imagem: jpeg(5000), miniatura: jpeg(300), largura: 1200, altura: 900 });
  assert.equal(r.s, 201, JSON.stringify(r.j));
  const id = r.j.id;
  r = await h.api(h.users.almox, 'POST', `${API}/MAN8921/fotos`, { imagem: jpeg(5000), miniatura: jpeg(300) });
  assert.equal(r.s, 409, 'a mesma foto duas vezes não duplica');
  r = await h.api(h.users.tec, 'GET', `${API}/MAN8921`);
  assert.equal(r.j.item.fotos, 1); assert.equal(r.j.item.capa, id); assert.equal(r.j.podeEditar, false);
  const foto = await h.raw(h.users.tec, 'GET', `${API}/MAN8921/fotos/${id}`);
  assert.equal(foto.status, 200);
  assert.equal(foto.headers.get('content-type'), 'image/jpeg');
  assert.equal(foto.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await h.raw(null, 'GET', `${API}/MAN8921/fotos/${id}`)).status, 401, 'sem login não vê a foto');
  r = await h.api(h.users.almox, 'DELETE', `${API}/MAN8921/fotos/${id}`);
  assert.equal(r.s, 200);
  assert.equal((await h.q("SELECT fotos, foto_capa FROM almox.material WHERE codigo='MAN8921'")).rows[0].fotos, 0);
});

test('técnico e PCM só consultam; o banco recusa escrita mesmo contornando a API', async () => {
  const body = { linhas: [{ codigo: 'MAN777', descricao: 'Tentativa' }] };
  assert.equal((await h.api(h.users.tec, 'POST', `${API}/importar`, body)).s, 403);
  assert.equal((await h.api(h.users.pcm, 'POST', `${API}/importar`, body)).s, 403);
  assert.equal((await h.api(h.users.pcm, 'PUT', `${API}/MAN8921`, { descricao: 'x' })).s, 403);
  assert.equal((await h.api(h.users.tec, 'POST', `${API}/MAN8921/fotos`, { imagem: jpeg(), miniatura: jpeg() })).s, 403);
  const n = await h.transaction({ id: h.users.pcm.id, email: h.users.pcm.email }, db => db.query("UPDATE almox.material SET descricao='hack' WHERE codigo='MAN8921'").then(x => x.rowCount));
  assert.equal(n, 0, 'RLS: PCM não altera o catálogo');
  const r = await h.api(h.users.almox, 'PUT', `${API}/MAN8921`, { descricao: 'DIAFRAGMA DN-40 GEMÜ', unidade: 'un', grupo: 'Válvulas', localizacao: 'A-12-4' });
  assert.equal(r.s, 200); assert.equal(r.j.item.localizacao, 'A-12-4'); assert.equal(r.j.item.unidade, 'UN');
});

test('planilha do Dynamics: reimportar atualiza só as colunas dela; o que o site preencheu fica', async () => {
  const campos = ['descricao', 'nomePesquisa', 'tipo', 'subtipo', 'statusMe', 'sped', 'armazenagem', 'unidade', 'fornecedor', 'ativo'];
  const dyn = [
    { codigo: 'MAN 4063', descricao: 'JOGO CHAVE DE FENDA PHILLIPS 7 PECAS', nomePesquisa: 'CHAVEDEFENDAPHILLIPS', tipo: 'Item', subtipo: 'Produto', statusMe: 'Integrado', armazenagem: 'SWL', ativo: true },
    { codigo: 'UCG0101', descricao: 'PLACA DE PETRI 100 X 15MM', tipo: 'Item', subtipo: 'Produto', statusMe: 'Integrado', armazenagem: 'WH', ativo: true },
    { codigo: 'SR0001', descricao: 'AUDITORIA, ASSESSORIA E CONSULTORIA', tipo: 'Serviço', subtipo: 'Produto', statusMe: 'Não integrar', armazenagem: 'WH', ativo: false },
    { codigo: 'BUCHA ALUM 1" ROSC', descricao: 'BUCHA ALUMINIO 1" ROSCA', tipo: 'Item', statusMe: 'Erro', armazenagem: 'SWL', ativo: true }
  ];
  let r = await h.api(h.users.almox, 'POST', `${API}/importar`, { linhas: dyn, campos, arquivo: 'DynamicsExport.xlsx' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.novos, 4, 'código com aspas do Dynamics também entra');
  // o almoxarifado completa no site
  r = await h.api(h.users.almox, 'PUT', `${API}/MAN4063`, { preco: '189,90', precoData: '2026-10-01', estoqueMinimo: '2', pontoPedido: 3, prazoDias: 15, criticidade: 'b', localizacao: 'A-03-2', familia: 'ferramenta', atributos: { tipo_ponta: 'Phillips', quantidade: '7' }, fabricante: 'Gedore', ncm: '8205.40.00' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.item.preco, 189.9); assert.equal(r.j.item.criticidade, 'B'); assert.equal(r.j.item.atributos.tipo_ponta, 'Phillips');
  // a mesma planilha de novo (o Dynamics renomeou o item): descrição muda, preço/local/família ficam
  r = await h.api(h.users.almox, 'POST', `${API}/importar`, { linhas: [{ ...dyn[0], descricao: 'JOGO CHAVE FENDA PHILLIPS 7 PCS' }], campos });
  assert.equal(r.j.atualizados, 1);
  r = await h.api(h.users.tec, 'GET', `${API}/MAN4063`);
  assert.equal(r.j.item.descricao, 'JOGO CHAVE FENDA PHILLIPS 7 PCS');
  assert.equal(r.j.item.preco, 189.9); assert.equal(r.j.item.localizacao, 'A-03-2'); assert.equal(r.j.item.familia, 'ferramenta'); assert.equal(r.j.item.statusMe, 'Integrado');
  assert.equal(r.j.item.atributos.quantidade, '7');
  // busca acha pelo que o site preencheu e pelo que veio do Dynamics
  assert.equal((await h.api(h.users.tec, 'GET', `${API}?q=gedore`)).j.rows[0].codigo, 'MAN4063');
  assert.equal((await h.api(h.users.tec, 'GET', `${API}?q=chavedefenda`)).j.rows[0].codigo, 'MAN4063');
  r = await h.api(h.users.almox, 'PUT', `${API}/MAN4063`, { preco: '-5' });
  assert.equal(r.s, 400, 'preço negativo não passa');
  r = await h.api(h.users.almox, 'PUT', `${API}/MAN4063`, { criticidade: 'Z' });
  assert.equal(r.s, 400);
  // nomes herdados do Object.prototype não são campos (antes "k in CAMPOS" os aceitava e a rota caía em erro interno)
  r = await h.api(h.users.almox, 'PUT', `${API}/MAN4063`, JSON.parse('{"constructor":"x","toString":"y","__proto__":{"col":"codigo"}}'));
  assert.deepEqual([r.s, r.j.erro], [400, 'Nada para salvar.']);
  r = await h.api(h.users.almox, 'POST', `${API}/importar`, { linhas: [{ codigo: 'MAN4063', descricao: 'CHAVE DE FENDA PHILLIPS', constructor: 'x' }], campos: ['constructor', 'hasOwnProperty', '__proto__'] });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await h.api(h.users.tec, 'GET', `${API}?q=MAN4063`)).j.rows[0].descricao, 'CHAVE DE FENDA PHILLIPS');
});

test('filtros combinados, ordem e contagens (facetas) para a lista', async () => {
  let r = await h.api(h.users.tec, 'GET', `${API}?prefixo=MAN&tipo=Item&ordem=preco&dir=desc`);
  assert.equal(r.s, 200);
  assert.equal(r.j.rows[0].codigo, 'MAN4063', 'quem tem preço vem primeiro na ordem por preço');
  assert.ok(r.j.rows.every(x => x.prefixo === 'MAN'));
  r = await h.api(h.users.tec, 'GET', `${API}?situacao=inativos`);
  assert.deepEqual(r.j.rows.map(x => x.codigo), ['SR0001']);
  r = await h.api(h.users.tec, 'GET', `${API}?statusMe=Erro`);
  assert.deepEqual(r.j.rows.map(x => x.codigo), ['BUCHAALUM1"ROSC']);
  r = await h.api(h.users.tec, 'GET', `${API}/facetas`);
  assert.equal(r.s, 200);
  assert.ok(r.j.prefixo.find(x => x.v === 'MAN').n >= 3000);
  assert.equal(r.j.totais.inativos, 1);
  assert.equal(r.j.totais.comPreco, 1);
  r = await h.api(h.users.tec, 'GET', `${API}/facetas?q=placa`);
  assert.deepEqual(r.j.prefixo, [{ v: 'UCG', n: 1 }], 'contagens seguem a busca');
});

test('ficha do item: descrição longa, marcas homologadas e pontos de recebimento; reimportar não apaga', async () => {
  let r = await h.api(h.users.almox, 'PUT', `${API}/MAN8921`, {
    descricaoLonga: 'Diafragma DN-40\n\n\n\nPTFE com reforço EPDM', marcasHomologadas: 'GEMÜ, Saunders', pontosRecebimento: 'Conferir o DN gravado.\nConferir o lote.'
  });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.item.descricaoLonga, 'Diafragma DN-40\n\nPTFE com reforço EPDM', 'quebras de linha ficam (no máximo uma linha em branco)');
  assert.equal(r.j.item.marcasHomologadas, 'GEMÜ, Saunders');
  r = await h.api(h.users.tec, 'GET', `${API}?q=saunders`);
  assert.ok(r.j.rows.some(x => x.codigo === 'MAN8921'), 'marca homologada entra na busca');
  r = await h.api(h.users.tec, 'PUT', `${API}/MAN8921`, { pontosRecebimento: 'x' });
  assert.equal(r.s, 403, 'só o almoxarifado edita a ficha');
  await h.api(h.users.almox, 'POST', `${API}/importar`, { linhas: [{ codigo: 'MAN8921', descricao: 'DIAFRAGMA DN-40 GEMÜ PTFE/EPDM' }] });
  r = await h.api(h.users.almox, 'GET', `${API}/MAN8921`);
  assert.equal(r.j.item.pontosRecebimento, 'Conferir o DN gravado.\nConferir o lote.', 'a planilha do Dynamics não apaga os campos do site');
});

test('lista com a ficha resumida, "falta na ficha" e ciclo de vida do Dynamics', async () => {
  let r = await h.api(h.users.almox, 'POST', `${API}/importar`, { linhas: [{ codigo: 'MAN7001', descricao: 'VALVULA ESFERA 1"', descricaoLonga: 'Válvula esfera tripartida; inox 316; 1"', cicloVida: 'Produto Phase Out', unidade: 'UN' }],
    campos: ['descricao', 'descricaoLonga', 'cicloVida', 'unidade'] });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await h.api(h.users.almox, 'GET', `${API}?q=MAN7001`);
  const it = r.j.rows.find(x => x.codigo === 'MAN7001');
  assert.equal(it.cicloVida, 'Produto Phase Out');
  assert.match(it.descricaoLongaResumo, /tripartida/);
  assert.equal(it.temRecebimento, false);
  r = await h.api(h.users.almox, 'GET', `${API}?ficha=sem_longa&q=MAN7001`);
  assert.equal(r.j.total, 0, 'tem descrição longa: não aparece em "sem descrição longa"');
  r = await h.api(h.users.almox, 'GET', `${API}?ficha=sem_receb&q=MAN7001`);
  assert.equal(r.j.total, 1);
  r = await h.api(h.users.almox, 'GET', `${API}/facetas`);
  assert.ok(r.j.totais.ficha.longa >= 2 && r.j.totais.ficha.unidade > 1000, JSON.stringify(r.j.totais.ficha));
  assert.ok(Array.isArray(r.j.grupo));
});
