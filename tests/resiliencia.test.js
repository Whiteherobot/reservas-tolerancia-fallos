const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { crearCliente, Bulkhead } = require('../shared/resiliencia');
const { escuchar, esperar } = require('./ayuda');

function servidorQueCuenta(respuesta) {
  const llamadas = { n: 0 };
  const app = express();
  app.all('/{*ruta}', (req, res) => { llamadas.n++; respuesta(req, res, llamadas.n); });
  return { app, llamadas };
}

test('reintenta un GET que falla con 500 y termina bien', async () => {
  const { app, llamadas } = servidorQueCuenta((req, res, n) => res.status(n < 3 ? 500 : 200).json({ n }));
  const s = await escuchar(app);
  const cliente = crearCliente('x', s.url, { reintentos: 2, esperaInicial: 1, breaker: { volumeThreshold: 99 } });
  const r = await cliente.get('/');
  assert.equal(r.data.n, 3);
  assert.equal(llamadas.n, 3);
  await s.cerrar();
});

test('un POST no se reintenta salvo que sea idempotente', async () => {
  const { app, llamadas } = servidorQueCuenta((req, res) => res.status(500).end());
  const s = await escuchar(app);
  const cliente = crearCliente('x', s.url, { reintentos: 2, esperaInicial: 1, breaker: { volumeThreshold: 99 } });
  await assert.rejects(cliente.post('/', {}), { code: 'SERVICIO_NO_DISPONIBLE' });
  assert.equal(llamadas.n, 1);
  await assert.rejects(cliente.post('/', {}, { idempotente: true }));
  assert.equal(llamadas.n, 4);
  await s.cerrar();
});

test('un 4xx se devuelve tal cual, sin reintentos ni abrir el breaker', async () => {
  const { app, llamadas } = servidorQueCuenta((req, res) => res.status(409).json({ error: 'ocupado' }));
  const s = await escuchar(app);
  const cliente = crearCliente('x', s.url, { reintentos: 2, breaker: { volumeThreshold: 1 } });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(cliente.get('/'), (e) => e.response.status === 409);
  }
  assert.equal(llamadas.n, 5);
  assert.equal(cliente.estado(), 'cerrado');
  await s.cerrar();
});

test('con el breaker abierto falla de inmediato y se recupera después', async () => {
  let caido = true;
  const { app, llamadas } = servidorQueCuenta((req, res) => res.status(caido ? 503 : 200).json({}));
  const s = await escuchar(app);
  const cliente = crearCliente('x', s.url, { reintentos: 0, breaker: { volumeThreshold: 2, resetTimeout: 200 } });
  await assert.rejects(cliente.get('/'));
  await assert.rejects(cliente.get('/'));
  assert.equal(cliente.estado(), 'abierto');

  const antes = llamadas.n;
  const inicio = Date.now();
  await assert.rejects(cliente.get('/'), /circuit breaker abierto/);
  assert.equal(llamadas.n, antes, 'no llegó al servidor');
  assert.ok(Date.now() - inicio < 50);

  caido = false;
  await esperar(250);
  await cliente.get('/');
  assert.equal(cliente.estado(), 'cerrado');
  await s.cerrar();
});

test('el timeout corta una respuesta lenta', async () => {
  const { app } = servidorQueCuenta((req, res) => setTimeout(() => res.json({}), 500));
  const s = await escuchar(app);
  const cliente = crearCliente('x', s.url, { timeout: 100, reintentos: 0 });
  const inicio = Date.now();
  await assert.rejects(cliente.get('/'), { code: 'SERVICIO_NO_DISPONIBLE' });
  assert.ok(Date.now() - inicio < 400);
  await s.cerrar();
});

test('el bulkhead limita la concurrencia, encola y descarta el excedente', async () => {
  const b = new Bulkhead('prueba', 2, 3);
  let activas = 0;
  let maximo = 0;
  const tarea = async () => {
    activas++; maximo = Math.max(maximo, activas);
    await esperar(30);
    activas--;
    return 'ok';
  };
  const resultados = await Promise.allSettled(Array.from({ length: 8 }, () => b.ejecutar(tarea)));
  assert.equal(maximo, 2);
  assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 5);
  const rechazos = resultados.filter((r) => r.status === 'rejected');
  assert.equal(rechazos.length, 3);
  assert.ok(rechazos.every((r) => r.reason.code === 'BULKHEAD_LLENO'));
  assert.deepEqual(b.estado(), { activas: 0, maxConcurrentes: 2, enCola: 0, maxEnCola: 3, rechazadas: 3 });
});

test('si una tarea falla el bulkhead libera su lugar', async () => {
  const b = new Bulkhead('prueba', 1, 1);
  await assert.rejects(b.ejecutar(async () => { throw new Error('x'); }));
  assert.equal(await b.ejecutar(async () => 'sigue'), 'sigue');
});
