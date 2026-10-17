const Redis = require('ioredis');
const crearLogger = require('../../shared/logger');
const { crearApp, sembrarCatalogo } = require('./app');

const logger = crearLogger('inventario');
const PORT = Number(process.env.PORT || 3002);

// Sin cola offline: si Redis se cae, los comandos fallan enseguida en vez de esperar.
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { enableOfflineQueue: false });
redis.on('error', (error) => logger.error(`Redis: ${error.message}`));
redis.on('ready', () => sembrarCatalogo(redis).catch((error) => logger.error(error.message)));

crearApp({ redis }).listen(PORT, () => logger.info(`escuchando en el puerto ${PORT}`));
