const crearLogger = require('../../shared/logger');
const { crearApp } = require('./app');

const logger = crearLogger('pagos');
const PORT = Number(process.env.PORT || 3003);

crearApp().listen(PORT, () => logger.info(`escuchando en el puerto ${PORT}`));
