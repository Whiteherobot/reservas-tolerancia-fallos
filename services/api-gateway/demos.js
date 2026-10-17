const axios = require('axios');
const { randomUUID } = require('node:crypto');
const { esperar } = require('../../shared/resiliencia');

// Las cuatro demostraciones de fallos. Cada una provoca el fallo de verdad
// (con los interruptores de /admin de cada servicio), mide lo que pasa y lo
// vuelve a dejar como estaba.
function crearDemos({ urls, reservas, reservar, obtenerCartelera, urlPropia }) {
  const admin = axios.create({ timeout: 3000 });

  async function cronometrar(fn) {
    const inicio = Date.now();
    try {
      const r = await fn();
      return { ms: Date.now() - inicio, status: r.status, data: r.data };
    } catch (error) {
      return { ms: Date.now() - inicio, status: error.response?.status ?? 503, data: error.response?.data ?? { error: error.message } };
    }
  }

  const disponibles = async (eventoId) =>
    (await admin.get(`${urls.inventario}/inventario/${eventoId}`)).data.asientosDisponibles;

  const pedido = (eventoId, usuario, asientos = 1) => ({ eventoId, asientos, usuario, metodoPago: 'tarjeta' });

  async function inventarioFantasma({ eventoId = 'evento-1' }) {
    const pasos = [];
    await obtenerCartelera();
    const antes = await disponibles(eventoId);
    pasos.push({ accion: 'Cartelera cargada con el inventario funcionando', resultado: `${eventoId}: ${antes} asientos` });

    await admin.post(`${urls.inventario}/admin/caida`, { activar: true });
    try {
      pasos.push({ accion: 'Se cae el servicio de inventario', resultado: 'Responde 503 a todo' });

      const cartelera = await obtenerCartelera().catch(() => null);
      pasos.push({
        accion: 'Pedir la cartelera',
        resultado: cartelera?.desdeCache
          ? `Se muestra la última copia (de hace ${Math.round(cartelera.edadMs / 1000)} s), marcada como copia`
          : 'Sin copia disponible'
      });

      for (let i = 1; i <= 4; i++) {
        const r = await cronometrar(() => reservar(pedido(eventoId, `fantasma${i}@demo.ec`)));
        pasos.push({
          accion: `Intento de reserva ${i}`,
          resultado: `${r.status} en ${r.ms} ms${r.data.motivo ? ` (${r.data.motivo})` : ''}`
        });
      }
    } finally {
      await admin.post(`${urls.inventario}/admin/caida`, { activar: false });
    }

    pasos.push({ accion: 'Se recupera el inventario', resultado: 'Se espera a que el circuit breaker pase a semiabierto (5 s)' });
    await esperar(5500);
    const r = await cronometrar(() => reservar(pedido(eventoId, 'recuperado@demo.ec')));
    pasos.push({ accion: 'Reserva después de la recuperación', resultado: `${r.status} (${r.data.estado ?? r.data.error})` });
    if (r.data.id && ['confirmada', 'pago-pendiente'].includes(r.data.estado)) {
      await reservas.delete(`/reservas/${r.data.id}`).catch(() => {});
      pasos.push({ accion: 'Se cancela esa reserva de prueba', resultado: 'Pago reembolsado y asiento devuelto' });
    }
    const despues = await disponibles(eventoId);
    pasos.push({
      accion: 'Asientos al final',
      resultado: `${despues} (antes ${antes}): ${despues === antes ? 'no se vendió ningún asiento fantasma' : 'NO COINCIDE'}`
    });

    return {
      demo: 'Inventario fantasma',
      patrones: ['Circuit breaker', 'Reintentos con espera exponencial', 'Cartelera en caché (solo lectura)', 'Fallo rápido'],
      pasos,
      conclusion: 'Con el inventario caído no se vende nada a ciegas: los primeros pedidos fallan tras los reintentos y, con el breaker abierto, los siguientes fallan en milisegundos en vez de colgarse. La cartelera se sigue viendo desde la copia.'
    };
  }

  async function pasarelaLenta({ eventoId = 'evento-2', asientos = 1, latenciaMs = 12000 }) {
    const pasos = [];
    await admin.post(`${urls.pagos}/admin/latencia`, { ms: latenciaMs });
    let r;
    try {
      pasos.push({ accion: 'La pasarela de pagos se vuelve lenta', resultado: `Tarda ${latenciaMs / 1000} s por pago` });
      r = await cronometrar(() => reservar(pedido(eventoId, 'paciente@demo.ec', asientos)));
    } finally {
      await admin.post(`${urls.pagos}/admin/latencia`, { ms: 0 });
    }
    pasos.push({
      accion: 'Reservar',
      resultado: `${r.status} en ${(r.ms / 1000).toFixed(1)} s: ${r.data.estado ?? r.data.error} (el usuario no espera los ${latenciaMs / 1000} s)`
    });

    let estado = r.data.estado;
    const inicio = Date.now();
    while (estado === 'pago-pendiente' && Date.now() - inicio < latenciaMs + 10000) {
      await esperar(1000);
      estado = (await reservas.get(`/reservas/${r.data.id}`)).data.estado;
    }
    pasos.push({
      accion: 'El conciliador consulta la pasarela en segundo plano',
      resultado: `La reserva pasó a "${estado}" ${((Date.now() - inicio) / 1000).toFixed(0)} s después`
    });

    return {
      demo: 'Pasarela lenta',
      patrones: ['Timeout', 'Estado pendiente (HTTP 202)', 'Conciliación en segundo plano', 'Pago idempotente por reserva'],
      pasos,
      conclusion: 'El timeout corta la espera del usuario sin perder el pago: los asientos quedan retenidos y la reserva se confirma (o se anula y se devuelven) cuando la pasarela contesta.'
    };
  }

  async function diluvioPeticiones({ eventoId = 'evento-3', usuarios = 60 }) {
    const n = Math.min(Math.max(Number(usuarios) || 60, 10), 200);
    const contar = (resultados) => resultados.reduce((acc, r) => {
      const clave = r.status === 201 || r.status === 202 ? 'aceptadas'
        : r.status === 429 ? 'limitadas (429)'
        : r.status === 503 ? 'descartadas (503)'
        : r.status === 402 ? 'pago rechazado (402)' : `otras (${r.status})`;
      acc[clave] = (acc[clave] || 0) + 1;
      return acc;
    }, {});

    // 1) Un mismo cliente manda n pedidos de golpe al gateway.
    const api = axios.create({ baseURL: urlPropia(), timeout: 30000 });
    const unCliente = await Promise.all(Array.from({ length: n }, (_, i) =>
      cronometrar(() => api.post('/api/reservas', pedido(eventoId, `bot${i}@demo.ec`)))));

    // 2) n usuarios distintos a la vez (cada uno dentro de su límite).
    const inicio = Date.now();
    const muchos = await Promise.all(Array.from({ length: n }, (_, i) =>
      cronometrar(() => reservar(pedido(eventoId, `fan${i}@demo.ec`), randomUUID()))));
    const ms = Date.now() - inicio;

    const a = contar(unCliente);
    const b = contar(muchos);
    return {
      demo: 'Diluvio de peticiones',
      patrones: ['Rate limiting por cliente', 'Bulkhead con cola acotada', 'Load shedding (503 + Retry-After)'],
      pasos: [
        { accion: `Un solo cliente envía ${n} reservas a la vez`, resultado: Object.entries(a).map(([k, v]) => `${v} ${k}`).join(', ') },
        { accion: `${n} usuarios distintos reservan a la vez`, resultado: `${Object.entries(b).map(([k, v]) => `${v} ${k}`).join(', ')} en ${(ms / 1000).toFixed(1)} s` }
      ],
      metricas: { unCliente: a, muchosUsuarios: b },
      conclusion: 'El rate limiting frena a un cliente que abusa; el bulkhead deja pasar solo las reservas que el sistema puede atender a la vez, pone algunas en cola y rechaza al instante el resto, así nadie espera indefinidamente y los servicios no colapsan.'
    };
  }

  async function condicionCarrera({ usuarios = 10, asientos = 1 }) {
    const n = Math.min(Math.max(Number(usuarios) || 10, 2), 30);
    const k = Math.min(Math.max(Number(asientos) || 1, 1), 5);
    await admin.post(`${urls.inventario}/admin/eventos/evento-4`, { asientos: k });

    const resultados = await Promise.all(Array.from({ length: n }, (_, i) =>
      cronometrar(() => reservas.post('/reservas', pedido('evento-4', `carrera${i}@demo.ec`)))));
    const conAsiento = resultados.filter((r) => ['confirmada', 'pago-pendiente'].includes(r.data.estado)).length;
    const sinAsiento = resultados.filter((r) => r.status === 409).length;
    const quedan = await disponibles('evento-4');

    return {
      demo: 'Condición de carrera',
      patrones: ['Operación atómica en Redis (script Lua)', 'Asignación idempotente por reserva'],
      pasos: [
        { accion: `Stand-up con ${k} asiento(s)`, resultado: 'Evento preparado' },
        { accion: `${n} usuarios reservan 1 asiento al mismo tiempo`, resultado: `${conAsiento} con asiento, ${sinAsiento} sin asientos (409)` },
        { accion: 'Comprobación', resultado: `vendidos ${conAsiento} + disponibles ${quedan} = ${conAsiento + quedan} de ${k}: ${conAsiento + quedan === k ? 'sin sobreventa' : 'NO CUADRA'}` }
      ],
      metricas: { usuarios: n, asientos: k, conAsiento, sinAsiento, quedan },
      conclusion: 'Comprobar y descontar los asientos es una sola operación atómica en Redis, así que nunca se venden más asientos de los que hay, sin necesidad de bloquear el evento mientras se cobra.'
    };
  }

  return {
    'inventario-fantasma': inventarioFantasma,
    'pasarela-lenta': pasarelaLenta,
    'diluvio-peticiones': diluvioPeticiones,
    'condicion-carrera': condicionCarrera
  };
}

module.exports = { crearDemos };
