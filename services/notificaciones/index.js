const crearLogger = require('../../shared/logger');
const { crearApp } = require('./app');

const logger = crearLogger('notificaciones');
const PORT = Number(process.env.PORT || 3004);

crearApp().listen(PORT, () => logger.info(`escuchando en el puerto ${PORT}`));
