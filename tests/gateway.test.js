const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { crearApp } = require('../services/api-gateway/app');
const { levantarPila } = require('./pila');
const { escuchar } = require('./ayuda');

let p;
before(async () => { p = await levantarPila(); });
after(async () => { await p.cerrar(); });

async function gateway(limites) {
  const { app } = crearApp({ urls: p.urls, limites });
  const s = await escuchar(app);
  app.locals.urlPropia = s.url;
  return { ...s, api: axios.create({ baseURL: s.url, validateStatus: () => true }) };
}

const pedido = (i) => ({ eventoId: 'evento-3', asientos: 1, usuario: `u${i}@correo.ec` });

test('sirve el panel y reenvía las reservas', async () => {
  const g = await gateway();
  const panel = await g.api.get('/');
  assert.match(panel.headers['content-type'], /html/);
  const r = await g.api.post('/api/reservas', pedido(1));
  assert.equal(r.status, 201);
  assert.equal((await g.api.get(`/api/reservas/${r.data.id}`)).data.estado, 'confirmada');
  assert.equal((await g.api.get('/api/reservas/no-existe')).status, 404);
  assert.equal((await g.api.post('/api/reservas', { eventoId: 'evento-3' })).status, 400);
  await g.cerrar();
});

test('rate limiting: más reservas por minuto que el límite reciben 429', async () => {
  const g = await gateway({ reservas: 3 });
  const codigos = [];
  for (let i = 0; i < 5; i++) codigos.push((await g.api.post('/api/reservas', pedido(i))).status);
  assert.deepEqual(codigos, [201, 201, 201, 429, 429]);
  assert.equal((await g.api.get('/api/inventario')).status, 200, 'el resto de la API sigue respondiendo');
  await g.cerrar();
});

test('bulkhead: lo que no entra en la cola se descarta con 503 y Retry-After', async () => {
  await p.api.pagos.post('/admin/latencia', { ms: 200 });
  const g = await gateway({ concurrentes: 2, enCola: 2 });
  const r = await Promise.all(Array.from({ length: 8 }, (_, i) => g.api.post('/api/reservas', pedido(i))));
  await p.api.pagos.post('/admin/latencia', { ms: 0 });
  const descartadas = r.filter((x) => x.status === 503);
  assert.equal(descartadas.length, 4);
  assert.equal(descartadas[0].headers['retry-after'], '2');
  assert.equal(r.filter((x) => x.status === 201 || x.status === 202).length, 4);
  await g.cerrar();
});

test('con el inventario caído la cartelera sale de la copia, marcada', async () => {
  const g = await gateway();
  assert.equal((await g.api.get('/api/inventario')).headers['x-desde-cache'], undefined);
  await p.api.inventario.post('/admin/caida', { activar: true });
  const r = await g.api.get('/api/inventario');
  await p.api.inventario.post('/admin/caida', { activar: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 4);
  assert.ok(r.headers['x-desde-cache'] !== undefined);
  await g.cerrar();
});

test('sin copia previa y con el inventario caído responde 503', async () => {
  const g = await gateway();
  await p.api.inventario.post('/admin/caida', { activar: true });
  const r = await g.api.get('/api/inventario');
  await p.api.inventario.post('/admin/caida', { activar: false });
  assert.equal(r.status, 503);
  await g.cerrar();
});

test('/api/estado informa los servicios y métricas medidas', async () => {
  const g = await gateway();
  await g.api.get('/api/inventario');
  const { data } = await g.api.get('/api/estado');
  assert.deepEqual(Object.keys(data.servicios).sort(), ['api-gateway', 'inventario', 'notificaciones', 'pagos', 'reservas']);
  assert.ok(Object.values(data.servicios).every((s) => s.activo));
  assert.equal(data.breakers.reservas, 'cerrado');
  assert.equal(data.solicitudesUltimoMinuto, 1);
  assert.equal(typeof data.latenciaP50, 'number');
  assert.equal(data.porCodigo['200'], 1);
  await g.cerrar();
});

test('demo de condición de carrera: nunca se vende de más', async () => {
  const g = await gateway();
  const { data } = await g.api.post('/demo/condicion-carrera', { usuarios: 12, asientos: 3 });
  assert.equal(data.metricas.conAsiento, 3);
  assert.equal(data.metricas.sinAsiento, 9);
  assert.equal(data.metricas.quedan, 0);
  assert.equal((await g.api.post('/demo/no-existe')).status, 404);
  await g.cerrar();
});

test('demo del diluvio: reporta limitadas, aceptadas y descartadas', async () => {
  const g = await gateway({ reservas: 5, concurrentes: 2, enCola: 3 });
  await p.api.pagos.post('/admin/latencia', { ms: 100 });
  const { data } = await g.api.post('/demo/diluvio-peticiones', { usuarios: 10 });
  await p.api.pagos.post('/admin/latencia', { ms: 0 });
  assert.equal(data.metricas.unCliente['limitadas (429)'], 5);
  assert.equal(data.metricas.muchosUsuarios.aceptadas, 5);
  assert.equal(data.metricas.muchosUsuarios['descartadas (503)'], 5);
  await g.cerrar();
});
