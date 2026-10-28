/**
 * Cliente da API: api<T>(method, path, body?) devolve o corpo já conferido ou lança um erro tipado.
 *  - 409 → ErroConflito (o registro mudou; traz a versão atual quando o servidor manda);
 *  - 428 → ErroVersaoAusente (faltou expectedVersion);
 *  - 403 com precisa2fa → pergunta ao diálogo de 2FA registrado (registrarDialogo2fa) e repete UMA vez se ele confirmar;
 *    configurar2fa = a pessoa ainda não ativou o 2FA. Sem diálogo, ou se ele recusar: ErroPrecisa2fa.
 */
import type { RespostaConflito, RespostaPrecisa2fa } from '@biomanut/shared';
import { obterTransporte } from './transport';

export type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ErroApi extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
    readonly corpo: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroApi';
  }
}
export class ErroConflito extends ErroApi {
  override name = 'ErroConflito';
  get atual(): unknown {
    return (this.corpo as Partial<RespostaConflito> | null)?.row ?? null;
  }
}
export class ErroVersaoAusente extends ErroApi {
  override name = 'ErroVersaoAusente';
}
export class ErroPrecisa2fa extends ErroApi {
  override name = 'ErroPrecisa2fa';
  get configurar(): boolean {
    return (this.corpo as Partial<RespostaPrecisa2fa> | null)?.configurar2fa === true;
  }
}

/** Diálogo de 2FA (montado pelo shell): resolve true quando a pessoa confirmou o código (ou ativou o 2FA). */
export type Dialogo2fa = (pedido: { configurar: boolean; mensagem: string }) => Promise<boolean>;
let dialogo2fa: Dialogo2fa | null = null;

export function registrarDialogo2fa(fn: Dialogo2fa | null): void {
  dialogo2fa = fn;
}

const mensagemDe = (corpo: unknown, status: number): string => {
  const erro = (corpo as { erro?: unknown } | null)?.erro;
  return typeof erro === 'string' && erro ? erro : `Falha na requisição (HTTP ${status}).`;
};

export async function api<T>(method: Metodo, path: string, body?: unknown): Promise<T> {
  return chamar<T>(method, path, body, true);
}

async function chamar<T>(method: Metodo, path: string, body: unknown, podeRepetir: boolean): Promise<T> {
  const transporte = await obterTransporte();
  const { status, corpo } = await transporte.enviar({ method, path, body });
  if (status >= 200 && status < 300) return corpo as T;
  const mensagem = mensagemDe(corpo, status);
  if (status === 403 && (corpo as Partial<RespostaPrecisa2fa> | null)?.precisa2fa === true) {
    const erro = new ErroPrecisa2fa(status, mensagem, corpo);
    if (podeRepetir && dialogo2fa && (await dialogo2fa({ configurar: erro.configurar, mensagem }))) {
      return chamar<T>(method, path, body, false);
    }
    throw erro;
  }
  if (status === 409) throw new ErroConflito(status, mensagem, corpo);
  if (status === 428) throw new ErroVersaoAusente(status, mensagem, corpo);
  throw new ErroApi(status, mensagem, corpo);
}
