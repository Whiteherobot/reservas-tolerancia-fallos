const express = require('express');
const crearLogger = require('../../shared/logger');

const logger = crearLogger('notificaciones');

// Simula el envío de correos. No es crítico: si falla, la reserva sigue valiendo.
function crearApp() {
  const enviadas = [];
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ estado: 'ok', servicio: 'notificaciones' }));

  app.post('/notificaciones', (req, res) => {
    const { destinatario, asunto, mensaje, reservaId } = req.body ?? {};
    if (!destinatario || !asunto) {
      return res.status(400).json({ error: 'Se necesita destinatario y asunto' });
    }
    const notificacion = {
      id: enviadas.length + 1, destinatario, asunto, mensaje, reservaId, enviada: new Date().toISOString()
    };
    enviadas.push(notificacion);
    logger.info(`correo a ${destinatario}: ${asunto}`);
    res.status(201).json(notificacion);
  });

  app.get('/notificaciones', (req, res) => res.json(enviadas));

  return app;
}

module.exports = { crearApp };
