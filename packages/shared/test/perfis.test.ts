// Matriz de telas por perfil: as regras que docs/TELAS-POR-PERFIL.md (§3, §3.2, §12) e o menu da V5 fixam.
import { describe, expect, it } from 'vitest';
import { PERFIS, TELAS, TELA_IDS, acessoDaTela, ehPerfil, telasDoPerfil, type PerfilId } from '../src/index.js';

describe('perfis', () => {
  it('são os 7 da V5, nesta ordem', () => {
    expect(PERFIS).toEqual(['admin', 'gestor', 'pcm', 'almoxarife', 'lider', 'tecnico', 'viewer']);
    expect(ehPerfil('tecnico')).toBe(true);
    expect(ehPerfil('terminal')).toBe(false);
    expect(ehPerfil('ADMIN')).toBe(false);
  });

  it('todo perfil vê Início, Meus treinamentos e Meu perfil', () => {
    for (const p of PERFIS)
      for (const t of ['inicio', 'lms_meus', 'meu_perfil'] as const) expect(acessoDaTela(p, t)).toBe('escreve');
  });

  it('admin vê todas as telas', () => {
    expect(telasDoPerfil('admin')).toEqual(TELA_IDS);
  });

  it('técnico: os 5 itens do §3 (SCM como aba de Nova solicitação) e nada de gestão', () => {
    expect(telasDoPerfil('tecnico')).toEqual([
      'inicio',
      'almox_nova_sci',
      'almox_minhas',
      'almox_nova_scm',
      'util_apontar',
      'lms_meus',
      'meu_perfil',
    ]);
  });

  it('visualização nunca grava fora de Início, treinamentos e da própria conta', () => {
    const escreve = telasDoPerfil('viewer').filter((t) => acessoDaTela('viewer', t) === 'escreve');
    expect(escreve).toEqual(['inicio', 'lms_meus', 'meu_perfil']);
    expect(acessoDaTela('viewer', 'almox_nova_sci')).toBeNull();
  });

  it('correções do §3.2 e do menu: a policy é que vale', () => {
    expect(acessoDaTela('lider', 'util_apontar')).toBeNull();
    expect(acessoDaTela('lider', 'util_apontamentos')).toBeNull();
    expect(acessoDaTela('viewer', 'util_apontamentos')).toBeNull();
    expect(acessoDaTela('pcm', 'admin_auditoria')).toBeNull();
    expect(acessoDaTela('pcm', 'almox_gestao_sci')).toBeNull();
    expect(acessoDaTela('pcm', 'almox_aprovacoes_scm')).toBeNull();
    expect(acessoDaTela('gestor', 'almox_cadastros')).toBe('escreve');
  });

  it('itens exclusivos', () => {
    const quem = (t: keyof typeof TELAS): PerfilId[] => PERFIS.filter((p) => acessoDaTela(p, t) !== null);
    expect(quem('admin_fila_email')).toEqual(['admin']);
    expect(quem('admin_acesso')).toEqual(['admin']);
    expect(quem('admin_auditoria')).toEqual(['admin', 'gestor']);
    expect(quem('almox_emprestimo')).toEqual(['admin', 'gestor', 'almoxarife']);
    expect(quem('almox_catalogo')).toEqual(['admin', 'gestor', 'almoxarife']);
    expect(quem('almox_aprovacoes_scm')).toEqual(['admin', 'gestor', 'lider']);
    expect(quem('lms_gestao')).toEqual(['admin', 'gestor']);
    expect(quem('pcm')).toEqual(['admin', 'gestor', 'pcm', 'lider']);
  });
});
