const winston = require('winston');

const formato = winston.format.printf(({ level, message, timestamp, servicio }) =>
  `${timestamp} [${servicio}] ${level}: ${message}`);

module.exports = function crearLogger(servicio) {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    silent: process.env.NODE_ENV === 'test',
    defaultMeta: { servicio },
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      formato
    ),
    transports: [new winston.transports.Console()]
  });
};
