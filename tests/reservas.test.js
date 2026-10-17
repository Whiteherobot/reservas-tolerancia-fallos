const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { levantarPila } = require('./pila');
const { hasta, esperar } = require('./ayuda');

let p;
before(async () => { p = await levantarPila(); });
after(async () => { await p.cerrar(); });
beforeEach(async () => {
  await p.api.pagos.post('/admin/latencia', { ms: 0 });
  await p.api.inventario.post('/admin/caida', { activar: false });
  await esperar(0);
});

const reservar = (cuerpo, headers = {}) => p.api.reservas.post('/reservas', {
  eventoId: 'evento-2', asientos: 2, usuario: 'ana@correo.ec', ...cuerpo
}, { headers });

test('reserva confirmada: cobra, descuenta y avisa por correo', async () => {
  const antes = await p.asientos('evento-2');
  const r = await reservar({});
  assert.equal(r.status, 201);
  assert.equal(r.data.estado, 'confirmada');
  assert.equal(r.data.monto, 60);
  assert.equal(r.data.eventoNombre, 'Teatro clásico');
  assert.equal(await p.asientos('evento-2'), antes - 2);
  assert.equal((await p.api.pagos.get(`/pagos/reserva/${r.data.id}`)).data.estado, 'completado');
  await hasta(async () => (await p.api.notificaciones.get('/notificaciones')).data.some((n) => n.reservaId === r.data.id));
  await hasta(async () => (await p.api.reservas.get(`/reservas/${r.data.id}`)).data.notificada === true);
});

test('valida el pedido', async () => {
  assert.equal((await reservar({ asientos: 0 })).status, 400);
  assert.equal((await reservar({ asientos: 11 })).status, 400);
  assert.equal((await reservar({ usuario: 'no-es-correo' })).status, 400);
  assert.equal((await reservar({ eventoId: 'evento-9' })).status, 404);
});

test('sin asientos suficientes responde 409 y no cobra', async () => {
  const r = await reservar({ eventoId: 'evento-4', asientos: 3 });
  assert.equal(r.status, 409);
  assert.equal(r.data.causa, 'sin-asientos');
  assert.equal((await p.api.pagos.get(`/pagos/reserva/${r.data.id}`)).status, 404);
});

test('pago rechazado: se devuelven los asientos (compensación)', async () => {
  const antes = await p.asientos('evento-2');
  const r = await reservar({ metodoPago: 'tarjeta-sin-fondos' });
  assert.equal(r.status, 402);
  assert.equal(r.data.estado, 'rechazada');
  assert.equal(await p.asientos('evento-2'), antes);
});

test('con la misma Idempotency-Key no se reserva ni se cobra dos veces', async () => {
  const antes = await p.asientos('evento-2');
  const a = await reservar({}, { 'Idempotency-Key': 'clave-1' });
  const b = await reservar({}, { 'Idempotency-Key': 'clave-1' });
  assert.equal(a.data.id, b.data.id);
  assert.equal(b.status, 201);
  assert.equal(await p.asientos('evento-2'), antes - 2);
});

test('pasarela lenta: 202 pago pendiente y el conciliador la confirma', async () => {
  await p.api.pagos.post('/admin/latencia', { ms: 600 });
  const antes = await p.asientos('evento-2');
  const inicio = Date.now();
  const r = await reservar({});
  assert.equal(r.status, 202);
  assert.equal(r.data.estado, 'pago-pendiente');
  assert.ok(Date.now() - inicio < 600, 'no espera a la pasarela');
  assert.equal(await p.asientos('evento-2'), antes - 2, 'los asientos quedan retenidos');

  await esperar(700);
  await p.conciliar();
  const final = (await p.api.reservas.get(`/reservas/${r.data.id}`)).data;
  assert.equal(final.estado, 'confirmada');
  assert.equal(await p.asientos('evento-2'), antes - 2);
});

test('si el pago no se resuelve en el plazo se anula y se devuelven los asientos', async () => {
  const p2 = await levantarPila({ tiempos: { plazoPago: 100 } });
  try {
    await p2.api.pagos.post('/admin/latencia', { ms: 1500 });
    const antes = await p2.asientos('evento-1');
    const r = await p2.api.reservas.post('/reservas', { eventoId: 'evento-1', asientos: 1, usuario: 'b@correo.ec' });
    assert.equal(r.data.estado, 'pago-pendiente');
    await esperar(150);
    await p2.conciliar();
    const final = (await p2.api.reservas.get(`/reservas/${r.data.id}`)).data;
    assert.equal(final.estado, 'cancelada');
    assert.equal(await p2.asientos('evento-1'), antes);
    // El pago que estaba en curso ya no se cobra.
    await esperar(1500);
    assert.equal((await p2.api.pagos.get(`/pagos/reserva/${r.data.id}`)).data.estado, 'anulado');
  } finally {
    await p2.cerrar();
  }
});

test('cancelar reembolsa y devuelve los asientos; no se cancela dos veces', async () => {
  const antes = await p.asientos('evento-2');
  const r = await reservar({});
  const c = await p.api.reservas.delete(`/reservas/${r.data.id}`);
  assert.equal(c.status, 200);
  assert.equal(c.data.estado, 'cancelada');
  assert.equal(await p.asientos('evento-2'), antes);
  assert.equal((await p.api.pagos.get(`/pagos/reserva/${r.data.id}`)).data.estado, 'reembolsado');
  assert.equal((await p.api.reservas.delete(`/reservas/${r.data.id}`)).status, 409);
});

test('inventario caído: 503 sin cobrar, y con el breaker abierto falla al instante', async () => {
  await p.api.inventario.post('/admin/caida', { activar: true });
  const tiempos = [];
  for (let i = 0; i < 5; i++) {
    const inicio = Date.now();
    const r = await reservar({});
    tiempos.push(Date.now() - inicio);
    assert.equal(r.status, 503);
    assert.equal(r.data.causa, 'inventario-caido');
  }
  assert.equal(p.clientes.inventario.estado(), 'abierto');
  assert.ok(tiempos.at(-1) < 50, `el último tardó ${tiempos.at(-1)} ms`);
  const pagos = (await p.api.pagos.get('/pagos')).data;
  assert.ok(pagos.every((pg) => pg.estado !== 'procesando'));
});

test('si no se pueden devolver los asientos, el conciliador lo reintenta', async () => {
  const p2 = await levantarPila();
  try {
    const antes = await p2.asientos('evento-3');
    // El pago tarda y el inventario cae justo antes de que haya que devolver.
    await p2.api.pagos.post('/admin/latencia', { ms: 100 });
    const pendiente = p2.api.reservas.post('/reservas', {
      eventoId: 'evento-3', asientos: 2, usuario: 'c@correo.ec', metodoPago: 'tarjeta-sin-fondos'
    });
    await esperar(50);
    await p2.api.inventario.post('/admin/caida', { activar: true });
    const r = await pendiente;
    assert.equal(r.data.estado, 'rechazada');
    assert.equal(r.data.liberacionPendiente, true);
    assert.equal(await p2.redis.sismember('reservas:pendientes', r.data.id), 1);

    await p2.api.inventario.post('/admin/caida', { activar: false });
    await esperar(5100); // el breaker vuelve a semiabierto
    await p2.conciliar();
    assert.equal(await p2.asientos('evento-3'), antes);
    assert.equal(await p2.redis.sismember('reservas:pendientes', r.data.id), 0);
  } finally {
    await p2.cerrar();
  }
});
