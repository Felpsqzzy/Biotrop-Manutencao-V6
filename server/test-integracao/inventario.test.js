'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');
let h, U, snapshot, campaign, lineIds, itemIds;
test.before(async () => {
  h = await subirApp({ adm:'admin', ges:'gestor', alm:'almoxarife', c1:'tecnico', c2:'lider', c3:'viewer', fora:'tecnico' }); U=h.users;
  await h.q("INSERT INTO almox.material(codigo,descricao,unidade) VALUES('MAN-SINT-INV','Item sintético','UN'),('MAN-SINT-B','Outro item sintético','MT')");
});
test.after(async () => { if(h) { await h.fechar(); await h.db.close(); } });
async function api(u,method,path,body){ return h.api(u,method,'/api/inventario'+path,body); }
function ok(r,status=200){ assert.equal(r.s,status,JSON.stringify(r.j)); return r.j; }
function line(extra={}) { return { codigo:'MAN-SINT-INV',descricao:'Item sintético',unidade:'UN',site:'SINT',deposito:'DEP',localizacao:'L1',saldo:'10.000001',precoUnitario:'0.123456',dimensoesExtras:{camm:'CAMM-SINT'},origemPreco:{totalOriginal:'1.234560',metodo:'total/saldo; precisão6'},...extra }; }
async function base(nome, linhas) {
  const s=ok(await api(U.alm,'POST','/snapshots',{nome,dataReferencia:'2026-10-06'}),201).snapshot.id;
  ok(await api(U.alm,'POST',`/snapshots/${s}/linhas`,{linhas}),201);
  ok(await api(U.alm,'POST',`/snapshots/${s}/finalizar`));
  return { id:s, linhas:ok(await api(U.alm,'GET',`/snapshots/${s}/linhas`)).linhas };
}
// Cada inventário usa uma lista do Dynamics recém-importada (migration 37): base nova com as três posições sintéticas.
async function nova(nome='Base sintética') { const b=await base(nome,[line(),line({localizacao:'L2'}),line({localizacao:'L3'})]); return { id:b.id, ids:b.linhas.map(l=>l.id) }; }
test('inventário: gestão importa staging atômico, preserva dimensões, preço nulo e decimais exatos',async()=>{
  assert.equal((await api(U.c1,'POST','/snapshots',{nome:'Negado',dataReferencia:'2026-10-06'})).s,403);
  snapshot=ok(await api(U.alm,'POST','/snapshots',{nome:'Inventário sintético',dataReferencia:'2026-10-06',fonte:'Dados sintéticos'}),201).snapshot.id;
  ok(await api(U.alm,'POST',`/snapshots/${snapshot}/linhas`,{linhas:[line(),line({localizacao:'L2'}),line({localizacao:'L3'})]}),201);
  assert.equal((await api(U.alm,'POST',`/snapshots/${snapshot}/linhas`,{linhas:[line({localizacao:'L4'}),line()]})).s,409);
  let rows=ok(await api(U.alm,'GET',`/snapshots/${snapshot}/linhas`)).linhas;
  assert.equal(rows.length,3,'parte com duplicata deve reverter todas as suas linhas');
  assert.equal(rows[0].saldo,'10.000001'); assert.equal(rows[0].precoUnitario,'0.123456');
  assert.equal(rows[0].dimensoesExtras.camm,'CAMM-SINT'); assert.equal(rows[0].origemPreco.totalOriginal,'1.234560');
  lineIds=rows.map(r=>r.id);
  ok(await api(U.alm,'POST',`/snapshots/${snapshot}/finalizar`));
  assert.equal((await api(U.alm,'POST',`/snapshots/${snapshot}/linhas`,{linhas:[line({localizacao:'L5'})]})).s,403);
  assert.equal((await api(U.alm,'POST',`/snapshots/${snapshot}/descartar`)).s,403,'base finalizada não se apaga');
});
test('inventário: origem da importação — hash, data da exportação e pendências guardadas; rascunho pode ser descartado',async()=>{
  const hash='a'.repeat(64);
  const s=ok(await api(U.alm,'POST','/snapshots',{nome:'Com pendências',dataReferencia:'2026-10-06',dataExportacao:'2026-10-05',fonte:'export.xlsx',arquivoHash:hash,
    pendencias:[{linha:7,codigo:'MAN-NAO-EXISTE',motivo:'SEM CADASTRO no catálogo',tipo:'sem_cadastro'},{linha:9,codigo:'MAN-SINT-INV',motivo:'Sem depósito/localização',tipo:'sem_local'}],resumo:{linhasArquivo:9}}),201).snapshot;
  assert.equal(s.arquivo_hash,hash); assert.ok(!('pendencias' in s));
  const lista=ok(await api(U.alm,'GET','/snapshots')).snapshots.find(x=>x.id===s.id);
  assert.equal(lista.pendencias,2); assert.equal(lista.resumo.linhasArquivo,9);
  const p=ok(await api(U.alm,'GET',`/snapshots/${s.id}/pendencias`)).pendencias;
  assert.deepEqual(p.map(x=>x.tipo),['sem_cadastro','sem_local']);
  assert.equal((await api(U.alm,'POST','/snapshots',{nome:'Hash ruim',dataReferencia:'2026-10-06',arquivoHash:'xyz'})).s,400);
  ok(await api(U.alm,'POST',`/snapshots/${s.id}/linhas`,{linhas:[line()]}),201);
  ok(await api(U.alm,'POST',`/snapshots/${s.id}/descartar`));
  assert.equal((await api(U.alm,'GET',`/snapshots/${s.id}/pendencias`)).s,404);
});
test('inventário: prévia aponta códigos fora do catálogo (SEM CADASTRO)',async()=>{
  const r=ok(await api(U.alm,'POST','/codigos',{codigos:['MAN-SINT-INV','man-sint-b','MAN-FALTA-1']}));
  assert.deepEqual(r.faltando,['MAN-FALTA-1']);
  assert.equal((await api(U.c1,'POST','/codigos',{codigos:['MAN-SINT-INV']})).s,403);
});
test('inventário: três pessoas distintas, atribuição de qualquer perfil, API cega e isolamento RLS',async()=>{
  assert.equal((await api(U.adm,'POST','/campanhas',{nome:'Inválida',snapshotId:snapshot,linhaIds:lineIds,contador1Id:U.c1.id,contador2Id:U.c1.id,contador3Id:U.c3.id})).s,400);
  campaign=ok(await api(U.alm,'POST','/campanhas',{nome:'Campanha sintética',snapshotId:snapshot,linhaIds:lineIds,contador1Id:U.c1.id,contador2Id:U.c2.id,contador3Id:U.c3.id}),201).campanha.id;
  const rows=ok(await api(U.c1,'GET',`/campanhas/${campaign}/itens`)).itens;
  itemIds=rows.map(r=>r.id);
  for(const r of rows) for(const key of ['saldo','precoUnitario','origemPreco','quantidadeFinal','contagens','justificativas']) assert.ok(!(key in r),`contador recebeu ${key}`);
  assert.equal((await api(U.fora,'GET',`/campanhas/${campaign}/itens`)).s,404);
  assert.equal((await api(U.c1,'GET',`/campanhas/${campaign}/relatorio`)).s,403);
  await h.transaction({id:U.c1.id,email:U.c1.email},async db=>{
    assert.equal((await db.query('SELECT * FROM inventario.snapshot_linha')).rows.length,0);
    assert.equal((await db.query('SELECT * FROM inventario.contagem')).rows.length,0);
    assert.equal((await db.query('SELECT * FROM inventario.justificativa')).rows.length,0);
    assert.equal((await db.query('SELECT * FROM inventario.item WHERE campanha_id=$1',[campaign])).rows.length,3);
  });
  const people=ok(await api(U.alm,'GET','/usuarios')).usuarios;
  assert.ok(people.some(u=>u.id===U.c3.id),'viewer ativo deve poder ser designado');
});
test('inventário: primeira igual encerra; divergência vai à segunda e à terceira; aprovação exige justificativa e gestão',async()=>{
  const [equal,minus,plus]=itemIds;
  assert.equal((await api(U.c2,'POST',`/itens/${equal}/contagens`,{quantidade:'10.000001',expectedVersion:1})).s,403);
  assert.equal((await api(U.fora,'POST',`/itens/${equal}/contagens`,{quantidade:'10',expectedVersion:1})).s,403);
  assert.equal((await api(U.c1,'POST',`/itens/${equal}/contagens`,{quantidade:'10.000001'})).s,400);
  let r=ok(await api(U.c1,'POST',`/itens/${equal}/contagens`,{quantidade:'10.000001',expectedVersion:1}),201).item; assert.equal(r.encerrado,true);
  assert.equal((await api(U.c1,'POST',`/itens/${equal}/contagens`,{quantidade:'10',expectedVersion:1})).s,409);
  r=ok(await api(U.c1,'POST',`/itens/${minus}/contagens`,{quantidade:'9',expectedVersion:1}),201).item; assert.equal(r.etapa,2);
  assert.equal((await api(U.c2,'POST',`/itens/${minus}/contagens`,{quantidade:'10.000001',expectedVersion:1})).s,409);
  r=ok(await api(U.c2,'POST',`/itens/${minus}/contagens`,{quantidade:'10.000001',expectedVersion:2}),201).item; assert.equal(r.encerrado,true);
  r=ok(await api(U.c1,'POST',`/itens/${plus}/contagens`,{quantidade:'11',expectedVersion:1}),201).item; assert.equal(r.etapa,2);
  // justificativa só depois do resultado final
  assert.equal((await api(U.alm,'POST',`/itens/${plus}/justificativas`,{texto:'cedo demais'})).s,409);
  r=ok(await api(U.c2,'POST',`/itens/${plus}/contagens`,{quantidade:'12',expectedVersion:2}),201).item; assert.equal(r.etapa,3);
  r=ok(await api(U.c3,'POST',`/itens/${plus}/contagens`,{quantidade:'13',expectedVersion:3}),201).item; assert.equal(r.encerrado,true);
  const blind=ok(await api(U.c2,'GET',`/campanhas/${campaign}/itens`)).itens;
  assert.ok(blind.every(x=>!('contagens' in x)&&!('saldo' in x)), 'segunda contagem não recebe dados anteriores');
  const report=ok(await api(U.alm,'GET',`/campanhas/${campaign}/relatorio`)).relatorio;
  assert.equal(report.completas,3); assert.equal(report.iguais,2); assert.equal(report.divergentes,1); assert.equal(report.acuracidadePrimeiraContagem,'33.333333');
  assert.equal(report.sobras,'0.370368'); assert.equal(report.perdas,'0.000000'); assert.equal(report.absoluto,'0.370368');
  assert.equal(report.codigosDistintos,1); assert.equal(report.grupos.camm[0].chave,'Sem CAMM');
  // aprovação: almoxarife prepara, gestão aprova
  assert.equal((await api(U.alm,'POST',`/campanhas/${campaign}/fechar`)).s,403);
  assert.equal((await api(U.ges,'POST',`/campanhas/${campaign}/fechar`)).s,409,'divergência sem justificativa bloqueia');
  assert.equal((await api(U.c1,'POST',`/itens/${plus}/justificativas`,{texto:'Contador não justifica'})).s,403);
  assert.equal((await api(U.alm,'POST',`/itens/${plus}/justificativas`,{texto:'x'})).s,400);
  ok(await api(U.alm,'POST',`/itens/${plus}/justificativas`,{texto:'Sobra de 3 UN: entrada de NF não lançada (sintético).'}),201);
  const c=ok(await api(U.ges,'POST',`/campanhas/${campaign}/fechar`,{observacao:'Aprovado em teste sintético.'})).campanha;
  assert.equal(c.estado,'fechada'); assert.equal(c.fechado_por,U.ges.id); assert.equal(c.aprovacao_obs,'Aprovado em teste sintético.');
  assert.equal((await api(U.c1,'POST',`/itens/${plus}/contagens`,{quantidade:'1',expectedVersion:4})).s,409);
  assert.equal((await api(U.alm,'POST',`/itens/${plus}/justificativas`,{texto:'Depois de aprovado'})).s,409);
  const full=ok(await api(U.alm,'GET',`/campanhas/${campaign}/relatorio`));
  assert.equal(full.pessoas[U.ges.id],'Pessoa ges'); assert.equal(full.relatorio.linhas.find(l=>l.id===plus).justificativas.length,1);
});
test('inventário: listas por CAMM com contadores próprios; a mesma posição não entra em duas listas',async()=>{
  const { id:snapshot, ids:lineIds }=await nova();
  const dup=await api(U.alm,'POST','/campanhas',{nome:'Duplicada',snapshotId:snapshot,listas:[
    {camm:'CAMM A',linhaIds:[lineIds[0],lineIds[1]],contador1Id:U.c1.id,contador2Id:U.c2.id,contador3Id:U.c3.id},
    {camm:'CAMM B',linhaIds:[lineIds[1]],contador1Id:U.c2.id,contador2Id:U.c3.id,contador3Id:U.fora.id}]});
  assert.equal(dup.s,409); assert.match(dup.j.erro,/duas listas/);
  const c=ok(await api(U.alm,'POST','/campanhas',{nome:'Por CAMM',snapshotId:snapshot,listas:[
    {camm:'CAMM A',linhaIds:[lineIds[0],lineIds[1]],contador1Id:U.c1.id,contador2Id:U.c2.id,contador3Id:U.c3.id},
    {camm:'',linhaIds:[lineIds[2]],contador1Id:U.fora.id,contador2Id:U.c2.id,contador3Id:U.c3.id}]}),201).campanha.id;
  const doC1=ok(await api(U.c1,'GET',`/campanhas/${c}/itens`)).itens;
  assert.deepEqual(doC1.map(i=>i.camm),['CAMM A','CAMM A'],'contador só vê as posições das listas dele');
  const doFora=ok(await api(U.fora,'GET',`/campanhas/${c}/itens`)).itens;
  assert.equal(doFora.length,1); assert.equal(doFora[0].camm,'');
  const lista=ok(await api(U.fora,'GET','/campanhas')).campanhas.find(x=>x.id===c);
  assert.equal(lista.minhas,1); assert.equal(lista.sou_contador,true);
  const rel=ok(await api(U.alm,'GET',`/campanhas/${c}/relatorio`)).relatorio;
  assert.deepEqual(rel.grupos.camm.map(g=>[g.chave,g.posicoes]),[['CAMM A',2],['Sem CAMM',1]]);
});
test('inventário: gestão que conta não vê saldo, não justifica nem aprova o inventário aberto; Power BI também omite',async()=>{
  const { id:snapshot, ids:lineIds }=await nova();
  const c=ok(await api(U.alm,'POST','/campanhas',{nome:'Almoxarife conta',snapshotId:snapshot,listas:[{camm:'X',linhaIds:[lineIds[0]],contador1Id:U.alm.id,contador2Id:U.ges.id,contador3Id:U.c3.id}]}),201).campanha.id;
  const v=ok(await api(U.alm,'GET',`/campanhas/${c}/itens`));
  assert.equal(v.completo,false); assert.ok(!('saldo' in v.itens[0]) && !('contagens' in v.itens[0]));
  assert.equal((await api(U.alm,'GET',`/campanhas/${c}/relatorio`)).s,403);
  assert.equal(ok(await api(U.adm,'GET',`/campanhas/${c}/itens`)).completo,true,'quem não conta acompanha');
  const it=v.itens[0];
  ok(await api(U.alm,'POST',`/itens/${it.id}/contagens`,{quantidade:'1',expectedVersion:1}),201);
  ok(await api(U.ges,'POST',`/itens/${it.id}/contagens`,{quantidade:'2',expectedVersion:2}),201);
  ok(await api(U.c3,'POST',`/itens/${it.id}/contagens`,{quantidade:'3',expectedVersion:3}),201);
  assert.equal((await api(U.alm,'POST',`/itens/${it.id}/justificativas`,{texto:'Quem contou não justifica'})).s,403);
  ok(await api(U.adm,'POST',`/itens/${it.id}/justificativas`,{texto:'Falta confirmada na contraprova (sintético).'}),201);
  assert.equal((await api(U.ges,'POST',`/campanhas/${c}/fechar`)).s,403,'gestor que contou não aprova');
  const biAlm=ok(await api(U.alm,'GET','/bi'));
  assert.ok(!biAlm.campanhas.some(x=>x.id===c),'Power BI omite inventário aberto em que a pessoa conta');
  const biAdm=ok(await api(U.adm,'GET','/bi'));
  const linha=biAdm.campanhas.find(x=>x.id===c);
  assert.equal(linha.divergentes,1); assert.equal(linha.estado,'Aguardando aprovação');
  const pos=biAdm.posicoes.filter(x=>x.campanhaId===c);
  assert.equal(pos[0].situacao,'Divergente'); assert.equal(pos[0].camm,'X'); assert.match(pos[0].justificativa,/contraprova/);
  assert.equal(biAdm.contagens.filter(x=>x.campanhaId===c).length,3);
  ok(await api(U.adm,'POST',`/campanhas/${c}/fechar`),200);
  assert.ok(ok(await api(U.alm,'GET','/bi')).campanhas.some(x=>x.id===c&&x.estado==='Aprovado'),'aprovado volta a aparecer');
  assert.equal((await api(U.c1,'GET','/bi')).s,403);
});
test('inventário: role app não altera estado nem contagens diretamente; base e justificativa imutáveis inclusive proprietário',async()=>{
  await assert.rejects(h.transaction({id:U.alm.id,email:U.alm.email},db=>db.query('UPDATE inventario.item SET encerrado=true')),{code:'42501'});
  await assert.rejects(h.transaction({id:U.c1.id,email:U.c1.email},db=>db.query("INSERT INTO inventario.contagem(item_id,etapa,quantidade,por) VALUES($1,1,0,$2)",[itemIds[0],U.c1.id])),{code:'42501'});
  await assert.rejects(h.transaction({id:U.alm.id,email:U.alm.email},db=>db.query("INSERT INTO inventario.justificativa(item_id,texto,por) VALUES($1,'direto',$2)",[itemIds[2],U.alm.id])),{code:'42501'});
  await assert.rejects(h.q('UPDATE inventario.snapshot_linha SET saldo=999 WHERE snapshot_id=$1',[snapshot]),{code:'42501'});
  await assert.rejects(h.q('UPDATE inventario.contagem SET quantidade=999 WHERE item_id=$1',[itemIds[0]]),{code:'42501'});
  await assert.rejects(h.q("UPDATE inventario.justificativa SET texto='trocado'"),{code:'42501'});
});
test('inventário: falta de custo não bloqueia a aprovação (valorização parcial); falta de unidade bloqueia',async()=>{
  const b=await base('Sem custo',[line({precoUnitario:null}),line({localizacao:'L2',precoUnitario:null,unidade:''})]);
  assert.equal(b.linhas[0].precoUnitario,null);
  const c=ok(await api(U.alm,'POST','/campanhas',{nome:'Sem custo',snapshotId:b.id,linhaIds:b.linhas.map(l=>l.id),contador1Id:U.c1.id,contador2Id:U.c2.id,contador3Id:U.c3.id}),201).campanha.id;
  for(const item of ok(await api(U.c1,'GET',`/campanhas/${c}/itens`)).itens) ok(await api(U.c1,'POST',`/itens/${item.id}/contagens`,{quantidade:'10.000001',expectedVersion:1}),201);
  const rel=ok(await api(U.alm,'GET',`/campanhas/${c}/relatorio`)).relatorio;
  assert.equal(rel.valorizacaoCompleta,false); assert.equal(rel.valoresParciais.posicoes,0); assert.equal(rel.valoresParciais.cobertura,'0.000000');
  const e=await api(U.ges,'POST',`/campanhas/${c}/fechar`); assert.equal(e.s,409); assert.match(e.j.erro,/unidade/);
  const b2=await base('Sem custo, com unidade',[line({precoUnitario:null,localizacao:'L9'})]);
  const c2=ok(await api(U.alm,'POST','/campanhas',{nome:'Só quantidade',snapshotId:b2.id,linhaIds:[b2.linhas[0].id],contador1Id:U.c1.id,contador2Id:U.c2.id,contador3Id:U.c3.id}),201).campanha.id;
  const it=ok(await api(U.c1,'GET',`/campanhas/${c2}/itens`)).itens[0];
  ok(await api(U.c1,'POST',`/itens/${it.id}/contagens`,{quantidade:'10.000001',expectedVersion:1}),201);
  ok(await api(U.ges,'POST',`/campanhas/${c2}/fechar`));
});
test('inventário: submissões simultâneas não duplicam contagem; função recusa intruso sem depender da API',async()=>{
  const { id:snapshot, ids:lineIds }=await nova();
  const c=ok(await api(U.alm,'POST','/campanhas',{nome:'Concorrência sintética',snapshotId:snapshot,linhaIds:[lineIds[0]],contador1Id:U.c1.id,contador2Id:U.c2.id,contador3Id:U.c3.id}),201).campanha.id;
  const item=ok(await api(U.c1,'GET',`/campanhas/${c}/itens`)).itens[0];
  await assert.rejects(h.transaction({id:U.fora.id,email:U.fora.email},db=>db.query('SELECT inventario.executar($1,$2::jsonb)', ['contar',JSON.stringify({id:item.id,quantidade:'10.000001',expectedVersion:1})])),{code:'42501'});
  await assert.rejects(h.transaction({id:U.alm.id,email:U.alm.email},db=>db.query('SELECT inventario.executar($1,$2::jsonb)', ['fechar',JSON.stringify({id:c})])),{code:'42501'});
  const submitted=await Promise.all([api(U.c1,'POST',`/itens/${item.id}/contagens`,{quantidade:'10.000001',expectedVersion:1}),api(U.c1,'POST',`/itens/${item.id}/contagens`,{quantidade:'10.000001',expectedVersion:1})]);
  assert.deepEqual(submitted.map(x=>x.s).sort(),[201,409]);
  assert.equal((await h.q('SELECT count(*)::int AS n FROM inventario.contagem WHERE item_id=$1',[item.id])).rows[0].n,1);
});
test('inventário: reaplicar migrations 34, 36 e 37 conserva bases, campanhas, contagens e justificativas',async()=>{
  const fs=require('node:fs'), path=require('node:path');
  const count=async t=>(await h.q(`SELECT count(*)::int AS n FROM inventario.${t}`)).rows[0].n;
  const before=[await count('contagem'),await count('justificativa'),await count('item')];
  for(const f of ['34-inventario.sql','36-inventario-listas-e-aprovacao.sql','37-inventario-base-do-dia.sql']) await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../database/migrations',f),'utf8'));
  assert.deepEqual([await count('contagem'),await count('justificativa'),await count('item')],before);
  assert.equal((await h.q('SELECT estado FROM inventario.campanha WHERE id=$1',[campaign])).rows[0].estado,'fechada');
  assert.equal((await h.q("SELECT count(*)::int AS n FROM inventario.item WHERE camm='CAMM A'")).rows[0].n,2);
  await assert.rejects(h.transaction({id:U.alm.id,email:U.alm.email},db=>db.query('UPDATE inventario.item SET encerrado=false')),{code:'42501'});
  // a versão nova da função continua valendo depois de reaplicar tudo
  await assert.rejects(h.transaction({id:U.alm.id,email:U.alm.email},db=>db.query('SELECT inventario.executar($1,$2::jsonb)',['fechar',JSON.stringify({id:campaign})])),{code:'42501'});
});
test('inventário: cada inventário exige lista do Dynamics nova — base usada, importada há mais de 24 h ou exportação antiga são recusadas',async()=>{
  const trio={contador1Id:U.c1.id,contador2Id:U.c2.id,contador3Id:U.c3.id};
  const usada=await api(U.alm,'POST','/campanhas',{nome:'Reaproveitar',snapshotId:snapshot,linhaIds:lineIds,...trio});
  assert.equal(usada.s,409); assert.match(usada.j.erro,/já foi usada/);
  const velha=ok(await api(U.alm,'POST','/snapshots',{nome:'Velha',dataReferencia:'2026-10-01'}),201).snapshot.id;
  await h.q("UPDATE inventario.snapshot SET criado_em=now()-interval '2 days' WHERE id=$1",[velha]);
  ok(await api(U.alm,'POST',`/snapshots/${velha}/linhas`,{linhas:[line()]}),201); ok(await api(U.alm,'POST',`/snapshots/${velha}/finalizar`));
  const lv=ok(await api(U.alm,'GET',`/snapshots/${velha}/linhas`)).linhas[0].id;
  const r1=await api(U.alm,'POST','/campanhas',{nome:'Base velha',snapshotId:velha,linhaIds:[lv],...trio}); assert.equal(r1.s,409); assert.match(r1.j.erro,/24 horas/);
  const exp=ok(await api(U.alm,'POST','/snapshots',{nome:'Exportação velha',dataReferencia:'2026-10-06',resumo:{exportadoEm:new Date(Date.now()-30*3600e3).toISOString()}}),201).snapshot.id;
  ok(await api(U.alm,'POST',`/snapshots/${exp}/linhas`,{linhas:[line()]}),201); ok(await api(U.alm,'POST',`/snapshots/${exp}/finalizar`));
  const le=ok(await api(U.alm,'GET',`/snapshots/${exp}/linhas`)).linhas[0].id;
  const r2=await api(U.alm,'POST','/campanhas',{nome:'Exportação velha',snapshotId:exp,linhaIds:[le],...trio}); assert.equal(r2.s,409); assert.match(r2.j.erro,/antiga/);
  const hoje=ok(await api(U.alm,'POST','/snapshots',{nome:'Exportação de agora',dataReferencia:'2026-10-07',resumo:{exportadoEm:new Date().toISOString()}}),201).snapshot.id;
  ok(await api(U.alm,'POST',`/snapshots/${hoje}/linhas`,{linhas:[line()]}),201); ok(await api(U.alm,'POST',`/snapshots/${hoje}/finalizar`));
  const lh=ok(await api(U.alm,'GET',`/snapshots/${hoje}/linhas`)).linhas[0].id;
  ok(await api(U.alm,'POST','/campanhas',{nome:'Exportação de agora',snapshotId:hoje,linhaIds:[lh],...trio}),201);
});
test('inventário: várias contagens de uma vez (colar do Excel) gravam o que é válido e devolvem o motivo do resto',async()=>{
  const { id, ids }=await nova('Base para colar');
  const c=ok(await api(U.alm,'POST','/campanhas',{nome:'Colar do Excel',snapshotId:id,linhaIds:ids,contador1Id:U.c1.id,contador2Id:U.c2.id,contador3Id:U.c3.id}),201).campanha.id;
  const itens=ok(await api(U.c1,'GET',`/campanhas/${c}/itens`)).itens;
  assert.equal((await api(U.c1,'POST','/contagens',{contagens:[]})).s,400);
  const r=ok(await api(U.c1,'POST','/contagens',{contagens:[
    {id:itens[0].id,quantidade:'10.000001',expectedVersion:1},
    {id:itens[1].id,quantidade:'0',expectedVersion:1},
    {id:itens[2].id,quantidade:'-1',expectedVersion:1}]}),201);
  assert.equal(r.gravadas,2); assert.deepEqual(r.resultados.map(x=>x.ok),[true,true,false]); assert.match(r.resultados[2].erro,/negativ/);
  const outro=ok(await api(U.c2,'POST','/contagens',{contagens:[{id:itens[2].id,quantidade:'1',expectedVersion:1}]}),201);
  assert.equal(outro.gravadas,0); assert.match(outro.resultados[0].erro,/etapa/);
  const dup=ok(await api(U.c1,'POST','/contagens',{contagens:[{id:itens[2].id,quantidade:'1',expectedVersion:1},{id:itens[2].id,quantidade:'2',expectedVersion:1}]}),201);
  assert.deepEqual(dup.resultados.map(x=>x.ok),[true,false]);
});
