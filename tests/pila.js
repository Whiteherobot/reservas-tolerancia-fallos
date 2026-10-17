// Levanta los cuatro servicios en memoria (con un Redis real) para las pruebas.
const axios = require('axios');
const inventario = require('../services/inventario/app');
const pagos = require('../services/pagos/app');
const notificaciones = require('../services/notificaciones/app');
const reservas = require('../services/reservas/app');
const { escuchar, redisDePrueba } = require('./ayuda');

async function levantarPila({ tiempos } = {}) {
  const redis = await redisDePrueba();
  await inventario.sembrarCatalogo(redis);
  const inv = await escuchar(inventario.crearApp({ redis }));
  const pag = await escuchar(pagos.crearApp({ probRechazo: 0, demoraNormalMs: 10 }));
  const not = await escuchar(notificaciones.crearApp());
  const urls = { inventario: inv.url, pagos: pag.url, notificaciones: not.url };
  const res = reservas.crearApp({ redis, urls, tiempos: { timeoutPago: 300, plazoPago: 60000, ...tiempos } });
  const rsv = await escuchar(res.app);
  urls.reservas = rsv.url;

  const cliente = (url) => axios.create({ baseURL: url, validateStatus: () => true });
  return {
    redis,
    urls,
    conciliar: res.conciliar,
    clientes: res.clientes,
    api: { inventario: cliente(inv.url), pagos: cliente(pag.url), notificaciones: cliente(not.url), reservas: cliente(rsv.url) },
    async asientos(eventoId) {
      return (await axios.get(`${inv.url}/inventario/${eventoId}`)).data.asientosDisponibles;
    },
    async cerrar() {
      await Promise.all([inv, pag, not, rsv].map((s) => s.cerrar()));
      redis.disconnect();
    }
  };
}

module.exports = { levantarPila };
