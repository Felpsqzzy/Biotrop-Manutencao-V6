// Cliente da API: corpo em 2xx, erros tipados (409, 428, 403 de 2FA) e o diálogo de 2FA que repete o pedido uma vez.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ErroApi, ErroConflito, ErroPrecisa2fa, ErroVersaoAusente, registrarDialogo2fa } from './client';
import { definirTransporte, type Pedido, type RespostaBruta } from './transport';

function falso(...respostas: RespostaBruta[]) {
  const pedidos: Pedido[] = [];
  definirTransporte({
    enviar: async (p) => {
      pedidos.push(p);
      return respostas.shift() ?? { status: 500, corpo: null };
    },
  });
  return pedidos;
}

afterEach(() => {
  definirTransporte(null);
  registrarDialogo2fa(null);
});

describe('api<T>', () => {
  it('2xx devolve o corpo e manda método, caminho e corpo', async () => {
    const pedidos = falso({ status: 200, corpo: { ok: true, n: 1 } });
    await expect(api<{ n: number }>('POST', '/api/x', { a: 1 })).resolves.toEqual({ ok: true, n: 1 });
    expect(pedidos).toEqual([{ method: 'POST', path: '/api/x', body: { a: 1 } }]);
  });

  it('409 vira ErroConflito com a versão atual; 428 vira ErroVersaoAusente; resto vira ErroApi com a mensagem do servidor', async () => {
    falso({
      status: 409,
      corpo: { ok: false, conflito: true, erro: 'O registro foi alterado por outro usuário.', row: { v: 3 } },
    });
    const e409 = await api('PUT', '/api/data/sci/1', {}).catch((e: unknown) => e);
    expect(e409).toBeInstanceOf(ErroConflito);
    expect((e409 as ErroConflito).atual).toEqual({ v: 3 });
    expect((e409 as ErroConflito).message).toBe('O registro foi alterado por outro usuário.');

    falso({ status: 428, corpo: { ok: false, erro: 'Informe a versão atual do registro (expectedVersion).' } });
    await expect(api('PUT', '/api/data/sci/1', {})).rejects.toBeInstanceOf(ErroVersaoAusente);

    falso({ status: 400, corpo: null });
    const e400 = await api('GET', '/api/y').catch((e: unknown) => e);
    expect(e400).toBeInstanceOf(ErroApi);
    expect((e400 as ErroApi).message).toBe('Falha na requisição (HTTP 400).');
  });

  it('403 precisa2fa sem diálogo: ErroPrecisa2fa (configurar2fa exposto)', async () => {
    falso({ status: 403, corpo: { ok: false, precisa2fa: true, configurar2fa: true, erro: 'Ative o 2FA.' } });
    const e = await api('POST', '/api/admin').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErroPrecisa2fa);
    expect((e as ErroPrecisa2fa).configurar).toBe(true);
  });

  it('403 precisa2fa com diálogo confirmado: repete o pedido UMA vez', async () => {
    const dialogo = vi.fn(async () => true);
    registrarDialogo2fa(dialogo);
    const pedidos = falso(
      { status: 403, corpo: { ok: false, precisa2fa: true, erro: 'Confirme.' } },
      { status: 200, corpo: { ok: true } },
    );
    await expect(api('POST', '/api/admin', { x: 1 })).resolves.toEqual({ ok: true });
    expect(dialogo).toHaveBeenCalledWith({ configurar: false, mensagem: 'Confirme.' });
    expect(pedidos).toHaveLength(2);
  });

  it('403 precisa2fa de novo depois de confirmar, ou diálogo recusado: não entra em laço', async () => {
    registrarDialogo2fa(async () => true);
    const corpo = { ok: false, precisa2fa: true, erro: 'Confirme.' };
    const pedidos = falso({ status: 403, corpo }, { status: 403, corpo }, { status: 200, corpo: {} });
    await expect(api('POST', '/api/admin')).rejects.toBeInstanceOf(ErroPrecisa2fa);
    expect(pedidos).toHaveLength(2);

    registrarDialogo2fa(async () => false);
    const outros = falso({ status: 403, corpo });
    await expect(api('POST', '/api/admin')).rejects.toBeInstanceOf(ErroPrecisa2fa);
    expect(outros).toHaveLength(1);
  });

  it('403 comum (sem precisa2fa) não abre o diálogo', async () => {
    const dialogo = vi.fn(async () => true);
    registrarDialogo2fa(dialogo);
    falso({ status: 403, corpo: { ok: false, erro: 'Sem permissão.' } });
    await expect(api('GET', '/api/z')).rejects.toMatchObject({ status: 403, message: 'Sem permissão.' });
    expect(dialogo).not.toHaveBeenCalled();
  });
});
