const Redis = require('ioredis');
const crearLogger = require('../../shared/logger');
const { crearApp } = require('./app');

const logger = crearLogger('reservas');
const PORT = Number(process.env.PORT || 3001);

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { enableOfflineQueue: false });
redis.on('error', (error) => logger.error(`Redis: ${error.message}`));

const { app, conciliar } = crearApp({
  redis,
  urls: {
    inventario: process.env.INVENTARIO_URL || 'http://localhost:3002',
    pagos: process.env.PAGOS_URL || 'http://localhost:3003',
    notificaciones: process.env.NOTIFICACIONES_URL || 'http://localhost:3004'
  },
  tiempos: {
    timeoutPago: Number(process.env.TIMEOUT_PAGO_MS || 5000),
    plazoPago: Number(process.env.PLAZO_PAGO_MS || 60000)
  }
});

let conciliando = false;
setInterval(async () => {
  if (conciliando || redis.status !== 'ready') return;
  conciliando = true;
  try { await conciliar(); } finally { conciliando = false; }
}, Number(process.env.CONCILIAR_CADA_MS || 3000)).unref();

app.listen(PORT, () => logger.info(`escuchando en el puerto ${PORT}`));
