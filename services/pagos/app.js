const express = require('express');
const { randomUUID } = require('node:crypto');
const crearLogger = require('../../shared/logger');
const { esperar } = require('../../shared/resiliencia');

const logger = crearLogger('pagos');

// Simula una pasarela de pagos externa. Cada reserva tiene a lo sumo un pago:
// repetir el pedido devuelve el mismo pago en vez de cobrar otra vez.
function crearApp(opciones = {}) {
  const config = {
    latenciaMs: Number(process.env.LATENCIA_MS || 0),
    demoraNormalMs: opciones.demoraNormalMs ?? 300,
    probRechazo: opciones.probRechazo ?? Number(process.env.PROB_RECHAZO || 0.05)
  };
  const pagos = new Map(); // reservaId -> pago

  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ estado: 'ok', servicio: 'pagos', latenciaMs: config.latenciaMs });
  });

  app.post('/admin/latencia', (req, res) => {
    const ms = Number(req.body?.ms ?? 0);
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) {
      return res.status(400).json({ error: 'ms debe estar entre 0 y 60000' });
    }
    config.latenciaMs = ms;
    logger.warn(`latencia simulada: ${ms} ms`);
    res.json({ latenciaMs: ms });
  });

  function respuesta(res, pago) {
    const codigo = { completado: 200, rechazado: 402, procesando: 202 }[pago.estado] ?? 200;
    res.status(codigo).json(pago);
  }

  app.post('/pagos', async (req, res) => {
    const { reservaId, monto, metodoPago, usuario } = req.body ?? {};
    if (!reservaId || !usuario || !metodoPago || !(Number(monto) > 0)) {
      return res.status(400).json({ error: 'Se necesita reservaId, monto > 0, metodoPago y usuario' });
    }

    const existente = pagos.get(reservaId);
    if (existente) return respuesta(res, existente);

    const pago = {
      id: randomUUID(),
      reservaId,
      monto: Number(monto),
      metodoPago,
      usuario,
      estado: 'procesando',
      creado: new Date().toISOString()
    };
    pagos.set(reservaId, pago);
    logger.info(`cobrando $${pago.monto} de la reserva ${reservaId}`);

    // El banco tarda lo mismo aunque el cliente ya no esté esperando: el pago
    // termina igual y queda consultable por GET /pagos/reserva/:id.
    await esperar(config.demoraNormalMs + config.latenciaMs);

    if (pago.estado === 'procesando') {
      const rechazado = metodoPago === 'tarjeta-sin-fondos' || Math.random() < config.probRechazo;
      pago.estado = rechazado ? 'rechazado' : 'completado';
      pago.terminado = new Date().toISOString();
      if (rechazado) pago.motivo = 'Tarjeta rechazada por el banco';
      logger.info(`pago de ${reservaId}: ${pago.estado}`);
    }
    respuesta(res, pago);
  });

  app.get('/pagos/reserva/:reservaId', (req, res) => {
    const pago = pagos.get(req.params.reservaId);
    if (!pago) return res.status(404).json({ error: 'No hay pago para esa reserva' });
    res.json(pago);
  });

  // Deshace el pago de una reserva: si todavía se procesaba se anula, si ya se
  // cobró se reembolsa. Repetirlo no cambia nada.
  app.post('/pagos/reserva/:reservaId/anulacion', (req, res) => {
    const pago = pagos.get(req.params.reservaId);
    if (!pago) {
      // Nunca llegó el pedido de cobro: se deja constancia para que, si llega
      // tarde, no se cobre.
      const anulado = { id: randomUUID(), reservaId: req.params.reservaId, estado: 'anulado', creado: new Date().toISOString() };
      pagos.set(req.params.reservaId, anulado);
      return res.json(anulado);
    }
    if (pago.estado === 'procesando') pago.estado = 'anulado';
    else if (pago.estado === 'completado') pago.estado = 'reembolsado';
    pago.motivoAnulacion = req.body?.motivo;
    logger.info(`pago de ${req.params.reservaId}: ${pago.estado}`);
    res.json(pago);
  });

  app.get('/pagos', (req, res) => res.json([...pagos.values()]));

  return app;
}

module.exports = { crearApp };
