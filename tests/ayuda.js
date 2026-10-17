const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';

function escuchar(app) {
  return new Promise((resolve) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${servidor.address().port}`;
      resolve({ url, servidor, cerrar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }) });
    });
  });
}

async function redisDePrueba() {
  const redis = new Redis(REDIS_URL, { enableOfflineQueue: true, maxRetriesPerRequest: 1 });
  await redis.flushdb();
  return redis;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasta(condicion, { cada = 50, maximo = 5000 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < maximo) {
    const valor = await condicion();
    if (valor) return valor;
    await esperar(cada);
  }
  throw new Error('la condición no se cumplió a tiempo');
}

module.exports = { escuchar, redisDePrueba, esperar, hasta };
