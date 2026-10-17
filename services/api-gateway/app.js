const path = require('node:path');
const express = require('express');
const axios = require('axios');
const { rateLimit } = require('express-rate-limit');
const crearLogger = require('../../shared/logger');
const { crearCliente, Bulkhead } = require('../../shared/resiliencia');
const { crearMetricas } = require('./metricas');
const { crearDemos } = require('./demos');

const logger = crearLogger('api-gateway');

function crearApp({ urls, limites = {} }) {
  const l = {
    general: 300, // solicitudes por minuto y cliente a /api
    reservas: 20, // reservas por minuto y cliente
    concurrentes: 10, // reservas que se procesan a la vez
    enCola: 20, // reservas que pueden esperar turno
    cacheInventarioMs: 5 * 60 * 1000,
    ...limites
  };

  // Si reservas contesta (aunque sea 503 porque el inventario está caído) es
  // que está vivo: solo cuentan como falla suya los timeouts y la conexión.
  const reservas = crearCliente('reservas', urls.reservas, {
    timeout: 12000, reintentos: 1, esRespuesta: (error) => Boolean(error.response),
    breaker: { errorThresholdPercentage: 60 }
  });
  const inventario = crearCliente('inventario', urls.inventario, { timeout: 2000, reintentos: 0 });
  const bulkhead = new Bulkhead('reservas', l.concurrentes, l.enCola);
  const metricas = crearMetricas();

  // Última cartelera buena: si el inventario cae se muestra marcada como
  // copia, pero nunca se usa para vender (eso lo decide el inventario).
  const cache = { eventos: null, fecha: 0, aciertos: 0 };

  async function obtenerCartelera() {
    try {
      const { data } = await inventario.get('/inventario');
      cache.eventos = data;
      cache.fecha = Date.now();
      return { eventos: data, desdeCache: false };
    } catch (error) {
      const edad = Date.now() - cache.fecha;
      if (cache.eventos && edad <= l.cacheInventarioMs) {
        cache.aciertos++;
        return { eventos: cache.eventos, desdeCache: true, edadMs: edad };
      }
      throw error;
    }
  }

  // Todo pedido de reserva pasa por el bulkhead. Un POST solo se reintenta si
  // trae Idempotency-Key, porque reservas lo deduplica.
  function reservar(datos, claveIdem) {
    return bulkhead.ejecutar(() => reservas.post('/reservas', datos, {
      headers: claveIdem ? { 'Idempotency-Key': claveIdem } : {},
      idempotente: Boolean(claveIdem)
    }));
  }

  function responderError(res, error) {
    if (error.response) return res.status(error.response.status).json(error.response.data);
    if (error.code === 'BULKHEAD_LLENO') {
      res.set('Retry-After', '2');
      return res.status(503).json({ error: 'Hay demasiadas reservas en curso, intente en unos segundos' });
    }
    logger.warn(error.message);
    return res.status(503).json({ error: 'Servicio no disponible por el momento', detalle: error.message });
  }

  async function estadoServicios() {
    const nombres = ['reservas', 'inventario', 'pagos', 'notificaciones'];
    const resultados = await Promise.all(nombres.map(async (nombre) => {
      try {
        const { data } = await axios.get(`${urls[nombre]}/health`, { timeout: 1000 });
        return [nombre, { activo: true, ...data }];
      } catch (error) {
        return [nombre, { activo: false, ...(error.response?.data ?? {}) }];
      }
    }));
    return { 'api-gateway': { activo: true }, ...Object.fromEntries(resultados) };
  }

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../../public')));

  app.get('/health', (req, res) => res.json({ estado: 'ok', servicio: 'api-gateway' }));

  const api = express.Router();
  api.use(metricas.middleware);
  api.use(rateLimit({
    windowMs: 60000,
    limit: l.general,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes, espere un momento' }
  }));
  const limiteReservas = rateLimit({
    windowMs: 60000,
    limit: l.reservas,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: `Máximo ${l.reservas} reservas por minuto` }
  });

  api.get('/inventario', async (req, res) => {
    try {
      const { eventos, desdeCache, edadMs } = await obtenerCartelera();
      if (desdeCache) res.set('X-Desde-Cache', String(Math.round(edadMs / 1000)));
      res.json(eventos);
    } catch (error) {
      res.status(503).json({ error: 'Inventario no disponible y sin copia reciente' });
    }
  });

  api.get('/reservas', async (req, res) => {
    try {
      res.json((await reservas.get('/reservas', { params: req.query })).data);
    } catch (error) { responderError(res, error); }
  });

  api.get('/reservas/:id', async (req, res) => {
    try {
      res.json((await reservas.get(`/reservas/${encodeURIComponent(req.params.id)}`)).data);
    } catch (error) { responderError(res, error); }
  });

  api.post('/reservas', limiteReservas, async (req, res) => {
    try {
      const { status, data } = await reservar(req.body, req.get('Idempotency-Key'));
      res.status(status).json(data);
    } catch (error) { responderError(res, error); }
  });

  api.delete('/reservas/:id', async (req, res) => {
    try {
      res.json((await reservas.delete(`/reservas/${encodeURIComponent(req.params.id)}`)).data);
    } catch (error) { responderError(res, error); }
  });

  api.get('/estado', async (req, res) => {
    res.json({
      servicios: await estadoServicios(),
      breakers: { reservas: reservas.estado(), inventario: inventario.estado() },
      bulkhead: bulkhead.estado(),
      cacheInventario: { aciertos: cache.aciertos, edadMs: cache.fecha ? Date.now() - cache.fecha : null },
      ...metricas.resumen()
    });
  });

  const demos = crearDemos({ urls, reservas, reservar, obtenerCartelera, urlPropia: () => app.locals.urlPropia });
  app.post('/demo/:nombre', async (req, res) => {
    const demo = demos[req.params.nombre];
    if (!demo) return res.status(404).json({ error: 'No existe esa demostración' });
    try {
      res.json(await demo(req.body ?? {}));
    } catch (error) {
      logger.error(`demo ${req.params.nombre}: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  app.use('/api', api);
  app.use((req, res) => res.status(404).json({ error: 'Ruta inexistente' }));
  app.use((error, req, res, next) => {
    logger.error(error.message);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Error interno' });
  });

  app.locals.urlPropia = null; // se fija al escuchar (la usa la demo del diluvio)
  return { app, bulkhead };
}

module.exports = { crearApp };
