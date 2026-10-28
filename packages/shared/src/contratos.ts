/**
 * Tipos dos contratos da API (o que o servidor em server/src/routes já responde hoje).
 * Só tipos: a validação continua no servidor. Novos contratos entram aqui quando a tela que os usa for implementada.
 */
import type { PerfilId } from './perfis.js';

/** Corpo de erro padrão das rotas: { ok: false, erro }. */
export interface RespostaErro {
  ok: false;
  erro: string;
}

/** 409 do /api/data quando outra pessoa alterou o registro (data.js): traz a versão atual. */
export interface RespostaConflito<T = unknown> extends RespostaErro {
  conflito: true;
  row: T | null;
}

/**
 * 403 do portão de 2FA (routes/twofa.js): precisa2fa = confirmar o código (step-up de 10 min);
 * configurar2fa = a pessoa ainda não ativou o 2FA e precisa ativar antes da ação administrativa.
 */
export interface RespostaPrecisa2fa extends RespostaErro {
  precisa2fa: true;
  configurar2fa?: true;
}

/** Usuário da sessão (GET /auth/me → { ok: true, usuario }). Campos além destes existem e são opcionais aqui. */
export interface UsuarioSessao {
  id: string;
  nome: string;
  email: string;
  perfilId: PerfilId;
  grupoId?: string | null;
  telefone?: string;
}

export interface RespostaMe {
  ok: true;
  usuario: UsuarioSessao;
}
