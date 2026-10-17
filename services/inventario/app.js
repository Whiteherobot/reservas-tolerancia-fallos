const express = require('express');
const crearLogger = require('../../shared/logger');

const logger = crearLogger('inventario');

const CATALOGO = [
  { id: 'evento-1', nombre: 'Concierto de rock', precio: 50, capacidad: 100 },
  { id: 'evento-2', nombre: 'Teatro clásico', precio: 30, capacidad: 50 },
  { id: 'evento-3', nombre: 'Festival de música', precio: 80, capacidad: 500 },
  { id: 'evento-4', nombre: 'Stand-up', precio: 25, capacidad: 1 }
];

// Cada evento es un hash en Redis y cada reserva que tiene asientos deja una
// asignación (asignacion:<reservaId>). Comprobar y descontar ocurre dentro de
// un script Lua, así que dos pedidos simultáneos no pueden vender el mismo
// asiento, y repetir el mismo pedido (reintento) no descuenta dos veces.
const ASIGNAR = `
local evento = KEYS[1]
local asignacion = KEYS[2]
local cantidad = tonumber(ARGV[1])
if redis.call('EXISTS', evento) == 0 then return {err = 'NO_EXISTE'} end
local previa = redis.call('HGET', asignacion, 'cantidad')
if previa then return {tonumber(previa), tonumber(redis.call('HGET', evento, 'disponibles')), 1} end
local disponibles = tonumber(redis.call('HGET', evento, 'disponibles'))
if disponibles < cantidad then return {err = 'SIN_ASIENTOS ' .. disponibles} end
redis.call('HINCRBY', evento, 'disponibles', -cantidad)
redis.call('HSET', asignacion, 'evento', ARGV[2], 'cantidad', cantidad)
return {cantidad, disponibles - cantidad, 0}
`;

// Devuelve los asientos de una asignación y la borra. Si ya no existe (se
// liberó antes o nunca se asignó) no hace nada: liberar dos veces no crea
// asientos de la nada.
const LIBERAR = `
local asignacion = KEYS[1]
local evento = redis.call('HGET', asignacion, 'evento')
if not evento then return {0, -1} end
local cantidad = tonumber(redis.call('HGET', asignacion, 'cantidad'))
local disponibles = redis.call('HINCRBY', 'evento:' .. evento, 'disponibles', cantidad)
redis.call('DEL', asignacion)
return {cantidad, disponibles}
`;

const claveEvento = (id) => `evento:${id}`;
const claveAsignacion = (reservaId) => `asignacion:${reservaId}`;

function aEvento(id, datos) {
  const disponibles = Number(datos.disponibles);
  return {
    id,
    nombre: datos.nombre,
    precio: Number(datos.precio),
    capacidad: Number(datos.capacidad),
    asientosDisponibles: disponibles,
    disponible: disponibles > 0
  };
}

function cantidadValida(cantidad) {
  return Number.isInteger(cantidad) && cantidad > 0 && cantidad <= 10;
}

async function sembrarCatalogo(redis) {
  for (const e of CATALOGO) {
    // Solo si no existe: reiniciar el servicio no debe devolver los asientos vendidos.
    const creado = await redis.hsetnx(claveEvento(e.id), 'nombre', e.nombre);
    if (creado) {
      await redis.hset(claveEvento(e.id), 'precio', e.precio, 'capacidad', e.capacidad, 'disponibles', e.capacidad);
      await redis.sadd('eventos', e.id);
    }
  }
}

function crearApp({ redis }) {
  const app = express();
  app.use(express.json());

  let simularCaida = process.env.SIMULAR_CAIDA === 'true';

  app.get('/health', async (req, res) => {
    const redisOk = redis.status === 'ready';
    res.status(redisOk ? 200 : 503).json({
      estado: redisOk ? 'ok' : 'sin-redis',
      servicio: 'inventario',
      simulandoCaida: simularCaida
    });
  });

  app.post('/admin/caida', (req, res) => {
    simularCaida = Boolean(req.body?.activar);
    logger.warn(`caída simulada ${simularCaida ? 'ACTIVADA' : 'desactivada'}`);
    res.json({ simulandoCaida: simularCaida });
  });

  // Solo para las demostraciones: deja un evento con una cantidad exacta de asientos.
  app.post('/admin/eventos/:id', async (req, res) => {
    const { asientos } = req.body ?? {};
    const base = CATALOGO.find((e) => e.id === req.params.id);
    if (!base) return res.status(404).json({ error: 'El evento no existe' });
    if (!Number.isInteger(asientos) || asientos < 0) {
      return res.status(400).json({ error: 'asientos debe ser un entero >= 0' });
    }
    await redis.hset(claveEvento(base.id), 'nombre', base.nombre, 'precio', base.precio,
      'capacidad', asientos, 'disponibles', asientos);
    await redis.sadd('eventos', base.id);
    res.json(aEvento(base.id, await redis.hgetall(claveEvento(base.id))));
  });

  app.use((req, res, next) => {
    if (simularCaida) {
      return res.status(503).json({ error: 'Inventario fuera de servicio (simulado)' });
    }
    next();
  });

  app.get('/inventario', async (req, res) => {
    const ids = (await redis.smembers('eventos')).sort();
    const eventos = await Promise.all(ids.map(async (id) => aEvento(id, await redis.hgetall(claveEvento(id)))));
    res.json(eventos);
  });

  app.get('/inventario/:id', async (req, res) => {
    const datos = await redis.hgetall(claveEvento(req.params.id));
    if (!datos.nombre) return res.status(404).json({ error: 'El evento no existe' });
    res.json(aEvento(req.params.id, datos));
  });

  app.post('/inventario/:id/asignaciones', async (req, res) => {
    const { reservaId, cantidad } = req.body ?? {};
    if (!reservaId || !cantidadValida(cantidad)) {
      return res.status(400).json({ error: 'Se necesita reservaId y una cantidad entre 1 y 10' });
    }
    try {
      const [asignados, disponibles, repetida] = await redis.eval(
        ASIGNAR, 2, claveEvento(req.params.id), claveAsignacion(reservaId), cantidad, req.params.id);
      const evento = aEvento(req.params.id, await redis.hgetall(claveEvento(req.params.id)));
      logger.info(`${req.params.id}: ${asignados} asiento(s) para ${reservaId}, quedan ${disponibles}`);
      res.status(repetida ? 200 : 201).json({
        reservaId, eventoId: evento.id, nombre: evento.nombre, precio: evento.precio,
        cantidad: asignados, asientosDisponibles: disponibles
      });
    } catch (error) {
      if (error.message.startsWith('NO_EXISTE')) return res.status(404).json({ error: 'El evento no existe' });
      if (error.message.startsWith('SIN_ASIENTOS')) {
        return res.status(409).json({
          error: 'No quedan suficientes asientos',
          solicitados: cantidad,
          disponibles: Number(error.message.split(' ')[1])
        });
      }
      throw error;
    }
  });

  app.delete('/inventario/asignaciones/:reservaId', async (req, res) => {
    const [liberados, disponibles] = await redis.eval(LIBERAR, 1, claveAsignacion(req.params.reservaId));
    if (liberados > 0) logger.info(`liberados ${liberados} asiento(s) de ${req.params.reservaId}`);
    res.json({ reservaId: req.params.reservaId, liberados, asientosDisponibles: disponibles >= 0 ? disponibles : null });
  });

  // Si Redis no responde no hay de dónde leer el inventario real: se contesta
  // 503 en lugar de inventar disponibilidad con una copia vieja en memoria.
  app.use((error, req, res, next) => {
    logger.error(`${req.method} ${req.path}: ${error.message}`);
    res.status(503).json({ error: 'Inventario no disponible' });
  });

  return app;
}

module.exports = { crearApp, sembrarCatalogo, CATALOGO };
