const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const Redis = require('ioredis');
const { crearApp, sembrarCatalogo } = require('../services/inventario/app');
const { escuchar, redisDePrueba } = require('./ayuda');

let redis, s, api;
before(async () => {
  redis = await redisDePrueba();
  s = await escuchar(crearApp({ redis }));
  api = axios.create({ baseURL: s.url, validateStatus: () => true });
});
after(async () => { await s.cerrar(); redis.disconnect(); });
beforeEach(async () => { await redis.flushdb(); await sembrarCatalogo(redis); });

const asignar = (eventoId, reservaId, cantidad) =>
  api.post(`/inventario/${eventoId}/asignaciones`, { reservaId, cantidad });

test('lista el catálogo con precio y asientos', async () => {
  const { data } = await api.get('/inventario');
  assert.equal(data.length, 4);
  assert.deepEqual(data[0], {
    id: 'evento-1', nombre: 'Concierto de rock', precio: 50, capacidad: 100, asientosDisponibles: 100, disponible: true
  });
});

test('volver a sembrar no devuelve los asientos ya vendidos', async () => {
  await asignar('evento-2', 'r1', 4);
  await sembrarCatalogo(redis);
  assert.equal((await api.get('/inventario/evento-2')).data.asientosDisponibles, 46);
});

test('asigna y descuenta; repetir la misma reserva no descuenta dos veces', async () => {
  const r1 = await asignar('evento-2', 'r1', 3);
  assert.equal(r1.status, 201);
  assert.equal(r1.data.asientosDisponibles, 47);
  assert.equal(r1.data.precio, 30);
  const r2 = await asignar('evento-2', 'r1', 3);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.asientosDisponibles, 47);
});

test('no vende más asientos de los que hay', async () => {
  const r = await asignar('evento-4', 'r1', 2);
  assert.equal(r.status, 409);
  assert.equal(r.data.disponibles, 1);
});

test('50 pedidos simultáneos por 5 asientos: exactamente 5 se asignan', async () => {
  await api.post('/admin/eventos/evento-4', { asientos: 5 });
  const resultados = await Promise.all(Array.from({ length: 50 }, (_, i) => asignar('evento-4', `r${i}`, 1)));
  assert.equal(resultados.filter((r) => r.status === 201).length, 5);
  assert.equal(resultados.filter((r) => r.status === 409).length, 45);
  assert.equal((await api.get('/inventario/evento-4')).data.asientosDisponibles, 0);
});

test('liberar devuelve los asientos una sola vez', async () => {
  await asignar('evento-1', 'r1', 2);
  const l1 = await api.delete('/inventario/asignaciones/r1');
  assert.equal(l1.data.liberados, 2);
  assert.equal(l1.data.asientosDisponibles, 100);
  const l2 = await api.delete('/inventario/asignaciones/r1');
  assert.equal(l2.data.liberados, 0);
  assert.equal((await api.get('/inventario/evento-1')).data.asientosDisponibles, 100);
});

test('liberar algo que nunca se asignó no crea asientos', async () => {
  await api.delete('/inventario/asignaciones/no-existe');
  assert.equal((await api.get('/inventario/evento-1')).data.asientosDisponibles, 100);
});

test('valida la cantidad y el evento', async () => {
  assert.equal((await asignar('evento-1', 'r1', 0)).status, 400);
  assert.equal((await asignar('evento-1', 'r1', 2.5)).status, 400);
  assert.equal((await asignar('evento-1', undefined, 1)).status, 400);
  assert.equal((await asignar('evento-9', 'r1', 1)).status, 404);
  assert.equal((await api.get('/inventario/evento-9')).status, 404);
});

test('la caída simulada responde 503 salvo /health y /admin', async () => {
  await api.post('/admin/caida', { activar: true });
  assert.equal((await api.get('/inventario')).status, 503);
  assert.equal((await api.get('/health')).data.simulandoCaida, true);
  await api.post('/admin/caida', { activar: false });
  assert.equal((await api.get('/inventario')).status, 200);
});

test('sin Redis contesta 503 en vez de inventar asientos', async () => {
  const sinRedis = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
  sinRedis.on('error', () => {});
  const otro = await escuchar(crearApp({ redis: sinRedis }));
  const r = await axios.post(`${otro.url}/inventario/evento-1/asignaciones`, { reservaId: 'x', cantidad: 1 }, { validateStatus: () => true });
  assert.equal(r.status, 503);
  assert.equal((await axios.get(`${otro.url}/health`, { validateStatus: () => true })).status, 503);
  await otro.cerrar();
  sinRedis.disconnect();
});
