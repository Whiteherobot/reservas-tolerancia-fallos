const crearLogger = require('../../shared/logger');
const { crearApp } = require('./app');

const logger = crearLogger('api-gateway');
const PORT = Number(process.env.PORT || 3000);

const { app } = crearApp({
  urls: {
    reservas: process.env.RESERVAS_URL || 'http://localhost:3001',
    inventario: process.env.INVENTARIO_URL || 'http://localhost:3002',
    pagos: process.env.PAGOS_URL || 'http://localhost:3003',
    notificaciones: process.env.NOTIFICACIONES_URL || 'http://localhost:3004'
  }
});
app.locals.urlPropia = `http://127.0.0.1:${PORT}`;

app.listen(PORT, () => logger.info(`escuchando en el puerto ${PORT}, panel en http://localhost:${PORT}`));
