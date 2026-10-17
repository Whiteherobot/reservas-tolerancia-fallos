const express = require('express');
const { randomUUID } = require('node:crypto');
const crearLogger = require('../../shared/logger');
const { crearCliente } = require('../../shared/resiliencia');

const logger = crearLogger('reservas');

const CODIGO_POR_ESTADO = {
  confirmada: 201,
  'pago-pendiente': 202,
  procesando: 409,
  cancelando: 409,
  cancelada: 200
};

// Cambia el estado solo si sigue siendo el esperado; así el conciliador y una
// cancelación que corren a la vez no se pisan.
const CAMBIAR_SI = `
local actual = redis.call('GET', KEYS[1])
if not actual then return 0 end
if cjson.decode(actual).estado ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

// Por qué se rechazó una reserva y con qué código HTTP se contesta.
const RECHAZOS = {
  'sin-asientos': { codigo: 409, motivo: 'No quedan suficientes asientos' },
  'evento-inexistente': { codigo: 404, motivo: 'El evento no existe' },
  'inventario-caido': { codigo: 503, motivo: 'Inventario no disponible, intente en unos segundos' },
  'pago-rechazado': { codigo: 402, motivo: 'Pago rechazado' }
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function crearApp({ redis, urls, tiempos = {} }) {
  const t = {
    timeoutPago: 5000, // lo que el usuario espera a la pasarela antes de recibir "pago pendiente"
    plazoPago: 60000, // lo que se espera un pago pendiente antes de anularlo y liberar los asientos
    ...tiempos
  };

  const inventario = crearCliente('inventario', urls.inventario, {
    timeout: 2000, reintentos: 2, breaker: { resetTimeout: 5000 }
  });
  const pagos = crearCliente('pagos', urls.pagos, {
    timeout: t.timeoutPago, reintentos: 0, breaker: { resetTimeout: 8000, errorThresholdPercentage: 70 }
  });
  const notificaciones = crearCliente('notificaciones', urls.notificaciones, {
    timeout: 2000, reintentos: 1
  });

  const clave = (id) => `reserva:${id}`;

  async function leer(id) {
    const json = await redis.get(clave(id));
    return json ? JSON.parse(json) : null;
  }

  async function guardar(reserva) {
    reserva.actualizada = new Date().toISOString();
    await redis.set(clave(reserva.id), JSON.stringify(reserva));
    if (['pago-pendiente', 'cancelando'].includes(reserva.estado) || reserva.liberacionPendiente || reserva.notificada === false) {
      await redis.sadd('reservas:pendientes', reserva.id);
    } else {
      await redis.srem('reservas:pendientes', reserva.id);
    }
    return reserva;
  }

  async function cambiarSi(reserva, desde, cambios) {
    const nueva = { ...reserva, ...cambios, actualizada: new Date().toISOString() };
    const ok = await redis.eval(CAMBIAR_SI, 1, clave(reserva.id), desde, JSON.stringify(nueva));
    if (!ok) return null;
    return guardar(nueva);
  }

  // Devolver asientos es idempotente en el inventario. Si no se puede ahora,
  // queda marcado y el conciliador lo reintenta.
  async function liberarAsientos(reserva) {
    try {
      await inventario.delete(`/inventario/asignaciones/${reserva.id}`);
      reserva.liberacionPendiente = false;
    } catch (error) {
      logger.error(`no se pudieron liberar los asientos de ${reserva.id}: ${error.message}`);
      reserva.liberacionPendiente = true;
    }
  }

  async function notificar(reserva) {
    try {
      await notificaciones.post('/notificaciones', {
        destinatario: reserva.usuario,
        asunto: `Reserva confirmada: ${reserva.eventoNombre}`,
        mensaje: `${reserva.asientos} asiento(s), total $${reserva.monto}. Código ${reserva.id}.`,
        reservaId: reserva.id
      });
      return true;
    } catch (error) {
      logger.warn(`notificación de ${reserva.id} pendiente: ${error.message}`);
      return false;
    }
  }

  // El correo no frena la respuesta al usuario; si falla se reintenta después.
  function notificarEnSegundoPlano(reserva) {
    notificar(reserva).then(async (ok) => {
      const actual = await leer(reserva.id);
      if (actual && actual.estado === 'confirmada') await guardar({ ...actual, notificada: ok });
    }).catch((error) => logger.error(error.message));
  }

  async function confirmar(reserva, pago) {
    const confirmada = await cambiarSi(reserva, reserva.estado, {
      estado: 'confirmada', pagoId: pago.id, notificada: false
    });
    if (!confirmada) return leer(reserva.id); // otro proceso ya la resolvió
    notificarEnSegundoPlano(confirmada);
    return confirmada;
  }

  async function rechazar(reserva, causa, conAsientos, motivo = RECHAZOS[causa].motivo) {
    reserva.estado = 'rechazada';
    reserva.causa = causa;
    reserva.motivo = motivo;
    if (conAsientos) await liberarAsientos(reserva);
    return guardar(reserva);
  }

  async function crearReserva({ eventoId, asientos, usuario, metodoPago }) {
    const reserva = await guardar({
      id: randomUUID(), eventoId, asientos, usuario, metodoPago, estado: 'procesando',
      creada: new Date().toISOString()
    });

    let asignacion;
    try {
      asignacion = (await inventario.post(`/inventario/${eventoId}/asignaciones`,
        { reservaId: reserva.id, cantidad: asientos }, { idempotente: true })).data;
    } catch (error) {
      if (error.response?.status === 409) return rechazar(reserva, 'sin-asientos', false);
      if (error.response?.status === 404) return rechazar(reserva, 'evento-inexistente', false);
      // No se sabe si la asignación llegó a hacerse: se deshace por las dudas.
      return rechazar(reserva, 'inventario-caido', true);
    }

    reserva.eventoNombre = asignacion.nombre;
    reserva.monto = asignacion.precio * asientos;
    reserva.estado = 'pago-pendiente';
    await guardar(reserva);

    try {
      const { status, data } = await pagos.post('/pagos', {
        reservaId: reserva.id, monto: reserva.monto, metodoPago, usuario
      }, { idempotente: true });
      if (status === 200) return confirmar(reserva, data);
      return reserva; // 202: la pasarela lo sigue procesando
    } catch (error) {
      if (error.response?.status === 402) {
        return rechazar(reserva, 'pago-rechazado', true, error.response.data.motivo);
      }
      // Timeout o pasarela caída: el cobro pudo haber ocurrido. Los asientos
      // quedan retenidos y el conciliador averigua cómo terminó.
      logger.warn(`pago de ${reserva.id} sin respuesta (${error.message}), queda pendiente`);
      return reserva;
    }
  }

  async function cancelar(reserva, motivo) {
    const desde = reserva.estado;
    const enCurso = await cambiarSi(reserva, desde, { estado: 'cancelando', motivo });
    if (!enCurso) return null;
    try {
      return await terminarCancelacion(enCurso);
    } catch (error) {
      await cambiarSi(enCurso, 'cancelando', { estado: desde, motivo: reserva.motivo });
      throw error;
    }
  }

  // Anular el pago y devolver los asientos son idempotentes: si una
  // cancelación se cortó a la mitad, el conciliador la repite entera.
  async function terminarCancelacion(enCurso) {
    await pagos.post(`/pagos/reserva/${enCurso.id}/anulacion`, { motivo: enCurso.motivo }, { idempotente: true });
    await liberarAsientos(enCurso);
    return cambiarSi(enCurso, 'cancelando', {
      estado: 'cancelada', liberacionPendiente: enCurso.liberacionPendiente
    });
  }

  // Revisa lo que quedó a medias: pagos sin respuesta, asientos por devolver,
  // cancelaciones interrumpidas y correos sin enviar.
  async function conciliar() {
    const ids = await redis.smembers('reservas:pendientes');
    for (const id of ids) {
      const reserva = await leer(id);
      if (!reserva) { await redis.srem('reservas:pendientes', id); continue; }
      try {
        if (reserva.estado === 'pago-pendiente') {
          await conciliarPago(reserva);
        } else if (reserva.estado === 'cancelando') {
          if (Date.now() - Date.parse(reserva.actualizada) > 30000) await terminarCancelacion(reserva);
        } else if (reserva.liberacionPendiente) {
          await liberarAsientos(reserva);
          await guardar(reserva);
        } else if (reserva.estado === 'confirmada' && reserva.notificada === false) {
          const ok = await notificar(reserva);
          await guardar({ ...reserva, notificada: ok });
        } else {
          await redis.srem('reservas:pendientes', id);
        }
      } catch (error) {
        logger.warn(`conciliación de ${id}: ${error.message}`);
      }
    }
  }

  async function conciliarPago(reserva) {
    let pago = null;
    try {
      pago = (await pagos.get(`/pagos/reserva/${reserva.id}`)).data;
    } catch (error) {
      if (error.response?.status !== 404) throw error;
    }
    if (pago?.estado === 'completado') {
      logger.info(`pago de ${reserva.id} confirmado por la pasarela`);
      return confirmar(reserva, pago);
    }
    if (pago?.estado === 'rechazado') {
      const enCurso = await cambiarSi(reserva, 'pago-pendiente', {
        estado: 'rechazada', causa: 'pago-rechazado', motivo: pago.motivo || RECHAZOS['pago-rechazado'].motivo
      });
      if (enCurso) { await liberarAsientos(enCurso); await guardar(enCurso); }
      return;
    }
    if (Date.now() - Date.parse(reserva.creada) > t.plazoPago) {
      logger.warn(`pago de ${reserva.id} sin resolver tras ${t.plazoPago} ms: se anula`);
      await cancelar(reserva, 'La pasarela de pagos no respondió a tiempo');
    }
  }

  const app = express();
  app.use(express.json());

  app.get('/health', async (req, res) => {
    res.json({
      estado: 'ok',
      servicio: 'reservas',
      pendientes: await redis.scard('reservas:pendientes'),
      breakers: { inventario: inventario.estado(), pagos: pagos.estado(), notificaciones: notificaciones.estado() }
    });
  });

  app.get('/reservas', async (req, res) => {
    const ids = await redis.zrevrange('reservas:todas', 0, 49);
    const reservas = (await Promise.all(ids.map(leer))).filter(Boolean);
    res.json(req.query.estado ? reservas.filter((r) => r.estado === req.query.estado) : reservas);
  });

  app.get('/reservas/:id', async (req, res) => {
    const reserva = await leer(req.params.id);
    if (!reserva) return res.status(404).json({ error: 'La reserva no existe' });
    res.json(reserva);
  });

  app.post('/reservas', async (req, res) => {
    const { eventoId, asientos, usuario, metodoPago = 'tarjeta' } = req.body ?? {};
    if (typeof eventoId !== 'string' || !Number.isInteger(asientos) || asientos < 1 || asientos > 10
      || typeof usuario !== 'string' || !EMAIL.test(usuario)) {
      return res.status(400).json({ error: 'Se necesita eventoId, asientos (1 a 10) y el correo del usuario' });
    }

    // Con Idempotency-Key, repetir el pedido devuelve la misma reserva.
    const claveIdem = req.get('Idempotency-Key');
    if (claveIdem) {
      const previa = await redis.get(`idem:${claveIdem}`);
      if (previa) {
        const reserva = await leer(previa);
        return res.status(codigo(reserva)).json(reserva);
      }
    }

    const reserva = await crearReserva({ eventoId, asientos, usuario, metodoPago });
    await redis.zadd('reservas:todas', Date.parse(reserva.creada), reserva.id);
    if (claveIdem) await redis.set(`idem:${claveIdem}`, reserva.id, 'EX', 86400, 'NX');
    res.status(codigo(reserva)).json(reserva);
  });

  app.delete('/reservas/:id', async (req, res) => {
    const reserva = await leer(req.params.id);
    if (!reserva) return res.status(404).json({ error: 'La reserva no existe' });
    if (!['confirmada', 'pago-pendiente'].includes(reserva.estado)) {
      return res.status(409).json({ error: `No se puede cancelar una reserva ${reserva.estado}` });
    }
    const cancelada = await cancelar(reserva, 'Cancelada por el usuario');
    if (!cancelada) return res.status(409).json({ error: 'La reserva cambió mientras se cancelaba, intente de nuevo' });
    res.json(cancelada);
  });

  app.use((error, req, res, next) => {
    logger.error(`${req.method} ${req.path}: ${error.message}`);
    res.status(503).json({ error: 'Servicio no disponible por el momento', detalle: error.message });
  });

  function codigo(reserva) {
    if (reserva.estado === 'rechazada') return RECHAZOS[reserva.causa].codigo;
    return CODIGO_POR_ESTADO[reserva.estado] ?? 200;
  }

  return { app, conciliar, clientes: { inventario, pagos, notificaciones } };
}

module.exports = { crearApp };
