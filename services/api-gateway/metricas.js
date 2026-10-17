// Métricas reales del gateway: solicitudes del último minuto y latencias de
// las últimas 200 respuestas de /api.
function crearMetricas() {
  const recientes = []; // marcas de tiempo del último minuto
  const latencias = [];
  const porCodigo = {};

  function percentil(p) {
    if (latencias.length === 0) return null;
    const ordenadas = [...latencias].sort((a, b) => a - b);
    return ordenadas[Math.min(ordenadas.length - 1, Math.floor(p * ordenadas.length))];
  }

  return {
    middleware(req, res, next) {
      const inicio = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
        recientes.push(Date.now());
        latencias.push(ms);
        if (latencias.length > 200) latencias.shift();
        porCodigo[res.statusCode] = (porCodigo[res.statusCode] || 0) + 1;
      });
      next();
    },
    resumen() {
      const haceUnMinuto = Date.now() - 60000;
      while (recientes.length && recientes[0] < haceUnMinuto) recientes.shift();
      const redondear = (v) => (v === null ? null : Math.round(v));
      return {
        solicitudesUltimoMinuto: recientes.length,
        latenciaP50: redondear(percentil(0.5)),
        latenciaP95: redondear(percentil(0.95)),
        porCodigo: { ...porCodigo }
      };
    }
  };
}

module.exports = { crearMetricas };
