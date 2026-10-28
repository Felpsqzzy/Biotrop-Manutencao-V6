// Transporte HTTP contra um servidor falso (msw): mesma origem, JSON no corpo e resposta sem JSON vira corpo null.
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODO_DEMO, transporteHttp } from './transport';

const servidor = setupServer(
  http.post('/api/eco', async ({ request }) =>
    HttpResponse.json({ ok: true, recebido: await request.json(), tipo: request.headers.get('content-type') }),
  ),
  http.get(
    '/api/texto',
    () => new HttpResponse('não é json', { status: 502, headers: { 'content-type': 'text/plain' } }),
  ),
);

beforeAll(() => servidor.listen());
afterAll(() => servidor.close());

describe('transporteHttp', () => {
  it('fora do build de demonstração, o modo demo está desligado', () => {
    expect(MODO_DEMO).toBe(false);
  });

  it('manda JSON e lê JSON', async () => {
    const r = await transporteHttp.enviar({ method: 'POST', path: '/api/eco', body: { a: 1 } });
    expect(r).toEqual({ status: 200, corpo: { ok: true, recebido: { a: 1 }, tipo: 'application/json' } });
  });

  it('resposta que não é JSON: status certo e corpo null', async () => {
    await expect(transporteHttp.enviar({ method: 'GET', path: '/api/texto' })).resolves.toEqual({
      status: 502,
      corpo: null,
    });
  });
});
