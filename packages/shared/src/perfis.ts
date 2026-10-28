/**
 * Perfis de acesso e telas por perfil (o que aparece no menu e com que nível).
 *
 * Fonte: docs/TELAS-POR-PERFIL.md §3 (menu) e §12 (matriz), com as correções que o próprio documento manda aplicar
 * ("a policy é que vale", §3.2), e o menu da V5 (web/src/ui/menu.js, commit dab3185):
 *  - PCM não vê a Gestão de SCI nem as Aprovações; a Gestão de SCM dele trata só a SCM de serviço (workflow.js);
 *  - Cadastros da SCI/SCM, Itens do estoque e Ferramentas e empréstimos: admin, gestor e almoxarife;
 *  - Apontar consumo: o líder sai (a RLS não deixa gravar); Apontamentos: líder e visualização saem (lista vazia);
 *  - Auditoria: admin e gestor; Fila de e-mail: só admin.
 *
 * Esconder do menu não fecha rota: quem decide é a API (server/src/routes) e a RLS do banco. Esta tabela só desenha a tela.
 */

export const PERFIS = ['admin', 'gestor', 'pcm', 'almoxarife', 'lider', 'tecnico', 'viewer'] as const;
export type PerfilId = (typeof PERFIS)[number];

/** escreve = abre e grava; le = só leitura. Ausente = não vê o item. */
export type Acesso = 'escreve' | 'le';

export type GrupoMenu = 'Início' | 'Almoxarifado' | 'Utilidades' | 'Treinamentos' | 'PCM' | 'Administração' | 'Conta';

export interface Tela {
  rotulo: string;
  grupo: GrupoMenu;
  acesso: Partial<Record<PerfilId, Acesso>>;
}

const TODOS: Record<PerfilId, Acesso> = {
  admin: 'escreve',
  gestor: 'escreve',
  pcm: 'escreve',
  almoxarife: 'escreve',
  lider: 'escreve',
  tecnico: 'escreve',
  viewer: 'escreve',
};
const SOLICITANTES = {
  admin: 'escreve',
  gestor: 'escreve',
  pcm: 'escreve',
  almoxarife: 'escreve',
  lider: 'escreve',
  tecnico: 'escreve',
} as const;
const GESTAO_ALMOX = { admin: 'escreve', gestor: 'escreve', almoxarife: 'escreve' } as const;
const GESTAO_PCM = { admin: 'escreve', gestor: 'escreve', pcm: 'escreve' } as const;

export const TELAS = {
  inicio: { rotulo: 'Início', grupo: 'Início', acesso: TODOS },
  almox_nova_sci: { rotulo: 'Nova solicitação', grupo: 'Almoxarifado', acesso: SOLICITANTES },
  almox_minhas: { rotulo: 'Minhas solicitações', grupo: 'Almoxarifado', acesso: SOLICITANTES },
  almox_gestao_sci: {
    rotulo: 'Gestão de SCI',
    grupo: 'Almoxarifado',
    acesso: { ...GESTAO_ALMOX, lider: 'le', viewer: 'le' },
  },
  almox_nova_scm: { rotulo: 'Nova solicitação de compra', grupo: 'Almoxarifado', acesso: SOLICITANTES },
  almox_gestao_scm: {
    rotulo: 'Gestão de SCM',
    grupo: 'Almoxarifado',
    acesso: { ...GESTAO_ALMOX, pcm: 'escreve', viewer: 'le' },
  },
  almox_aprovacoes_scm: {
    rotulo: 'Aprovações',
    grupo: 'Almoxarifado',
    acesso: { admin: 'escreve', gestor: 'escreve', lider: 'escreve' },
  },
  almox_cadastros: { rotulo: 'Cadastros da SCI e da SCM', grupo: 'Almoxarifado', acesso: GESTAO_ALMOX },
  almox_catalogo: { rotulo: 'Itens do estoque', grupo: 'Almoxarifado', acesso: GESTAO_ALMOX },
  almox_emprestimo: { rotulo: 'Ferramentas e empréstimos', grupo: 'Almoxarifado', acesso: GESTAO_ALMOX },
  util_apontar: {
    rotulo: 'Apontar consumo',
    grupo: 'Utilidades',
    acesso: { ...GESTAO_PCM, tecnico: 'escreve' },
  },
  util_apontamentos: { rotulo: 'Apontamentos', grupo: 'Utilidades', acesso: GESTAO_PCM },
  util_medidores: { rotulo: 'Gestão de medidores', grupo: 'Utilidades', acesso: GESTAO_PCM },
  lms_meus: { rotulo: 'Meus treinamentos', grupo: 'Treinamentos', acesso: TODOS },
  lms_visao_geral: {
    rotulo: 'Visão geral de treinamentos',
    grupo: 'Treinamentos',
    acesso: { admin: 'escreve', gestor: 'escreve', lider: 'escreve' },
  },
  lms_gestao: {
    rotulo: 'Gestão de treinamentos',
    grupo: 'Treinamentos',
    acesso: { admin: 'escreve', gestor: 'escreve' },
  },
  pcm: { rotulo: 'PCM', grupo: 'PCM', acesso: { ...GESTAO_PCM, lider: 'escreve' } },
  admin_acesso: {
    rotulo: 'Usuários, perfis, grupos e e-mails autorizados',
    grupo: 'Administração',
    acesso: { admin: 'escreve' },
  },
  admin_auditoria: {
    rotulo: 'Auditoria e saúde operacional',
    grupo: 'Administração',
    acesso: { admin: 'le', gestor: 'le' },
  },
  admin_fila_email: { rotulo: 'Fila de e-mail', grupo: 'Administração', acesso: { admin: 'le' } },
  meu_perfil: { rotulo: 'Meu perfil', grupo: 'Conta', acesso: TODOS },
} as const satisfies Record<string, Tela>;

export type TelaId = keyof typeof TELAS;

export const TELA_IDS = Object.keys(TELAS) as TelaId[];

export function ehPerfil(valor: unknown): valor is PerfilId {
  return typeof valor === 'string' && (PERFIS as readonly string[]).includes(valor);
}

/** Nível de acesso do perfil à tela, ou null se o item não aparece para ele. */
export function acessoDaTela(perfil: PerfilId, tela: TelaId): Acesso | null {
  const acesso: Partial<Record<PerfilId, Acesso>> = TELAS[tela].acesso;
  return acesso[perfil] ?? null;
}

/** Telas que o perfil vê, na ordem do menu. */
export function telasDoPerfil(perfil: PerfilId): TelaId[] {
  return TELA_IDS.filter((t) => acessoDaTela(perfil, t) !== null);
}
