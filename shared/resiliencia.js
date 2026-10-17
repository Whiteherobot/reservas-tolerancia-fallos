const CircuitBreaker = require('opossum');
const axios = require('axios');
const crearLogger = require('./logger');

const logger = crearLogger('resiliencia');

class ServicioNoDisponible extends Error {
  constructor(servicio, causa) {
    super(`${servicio} no disponible${causa ? `: ${causa}` : ''}`);
    this.code = 'SERVICIO_NO_DISPONIBLE';
    this.servicio = servicio;
  }
}

class BulkheadLleno extends Error {
  constructor(nombre) {
    super(`${nombre} saturado`);
    this.code = 'BULKHEAD_LLENO';
  }
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Un error 4xx es una respuesta válida del servicio (no está caído): no se
// reintenta ni cuenta como fallo para el circuit breaker.
function esErrorDelCliente(error) {
  return Boolean(error.response && error.response.status < 500);
}

const METODOS_IDEMPOTENTES = new Set(['get', 'head', 'put', 'delete']);

/**
 * Cliente HTTP con timeout, circuit breaker y reintentos.
 *
 * Solo se reintenta lo que se puede repetir sin efectos dobles: GET/PUT/DELETE
 * o un POST marcado con `idempotente: true` (el servicio de destino deduplica,
 * por ejemplo por id de reserva). Con el breaker abierto no se reintenta: se
 * falla de inmediato.
 */
function crearCliente(nombre, baseURL, opciones = {}) {
  const {
    timeout = 3000,
    reintentos = 2,
    esperaInicial = 200,
    // Qué errores son una respuesta legítima del servicio y no una falla suya.
    esRespuesta = esErrorDelCliente,
    breaker: opcionesBreaker = {}
  } = opciones;

  const http = axios.create({ baseURL, timeout });

  const breaker = new CircuitBreaker((config) => http.request(config), {
    name: nombre,
    timeout: false, // el timeout lo pone axios, que además corta la conexión
    errorThresholdPercentage: 50,
    volumeThreshold: 3,
    resetTimeout: 5000,
    rollingCountTimeout: 10000,
    errorFilter: esRespuesta,
    ...opcionesBreaker
  });

  breaker.on('open', () => logger.warn(`circuit breaker ABIERTO: ${nombre}`));
  breaker.on('halfOpen', () => logger.info(`circuit breaker SEMIABIERTO: ${nombre}`));
  breaker.on('close', () => logger.info(`circuit breaker CERRADO: ${nombre}`));

  async function solicitar(config) {
    const { idempotente, ...configAxios } = config;
    const repetible = idempotente || METODOS_IDEMPOTENTES.has(configAxios.method);
    const intentos = repetible ? reintentos + 1 : 1;

    for (let intento = 1; ; intento++) {
      try {
        return await breaker.fire(configAxios);
      } catch (error) {
        if (esRespuesta(error)) throw error;
        if (breaker.opened || error.code === 'EOPENBREAKER') {
          throw new ServicioNoDisponible(nombre, 'circuit breaker abierto');
        }
        if (intento >= intentos) throw new ServicioNoDisponible(nombre, error.message);
        const espera = esperaInicial * 2 ** (intento - 1) * (0.5 + Math.random());
        logger.warn(`${nombre}: intento ${intento} falló (${error.message}), reintento en ${Math.round(espera)} ms`);
        await esperar(espera);
      }
    }
  }

  return {
    nombre,
    breaker,
    get: (url, config = {}) => solicitar({ ...config, method: 'get', url }),
    post: (url, data, config = {}) => solicitar({ ...config, method: 'post', url, data }),
    delete: (url, config = {}) => solicitar({ ...config, method: 'delete', url }),
    estado() {
      if (breaker.opened) return 'abierto';
      if (breaker.halfOpen) return 'semiabierto';
      return 'cerrado';
    }
  };
}

/**
 * Bulkhead: limita cuántas operaciones corren a la vez y cuántas esperan.
 * Lo que no entra en la cola se rechaza enseguida (load shedding) en vez de
 * acumular memoria y latencia sin límite.
 */
class Bulkhead {
  constructor(nombre, maxConcurrentes, maxEnCola) {
    this.nombre = nombre;
    this.maxConcurrentes = maxConcurrentes;
    this.maxEnCola = maxEnCola;
    this.activas = 0;
    this.cola = [];
    this.rechazadas = 0;
  }

  ejecutar(fn) {
    if (this.activas < this.maxConcurrentes) return this._correr(fn);
    if (this.cola.length >= this.maxEnCola) {
      this.rechazadas++;
      return Promise.reject(new BulkheadLleno(this.nombre));
    }
    return new Promise((resolve, reject) => this.cola.push({ fn, resolve, reject }));
  }

  async _correr(fn) {
    this.activas++;
    try {
      return await fn();
    } finally {
      this.activas--;
      const siguiente = this.cola.shift();
      if (siguiente) this._correr(siguiente.fn).then(siguiente.resolve, siguiente.reject);
    }
  }

  estado() {
    return {
      activas: this.activas,
      maxConcurrentes: this.maxConcurrentes,
      enCola: this.cola.length,
      maxEnCola: this.maxEnCola,
      rechazadas: this.rechazadas
    };
  }
}

module.exports = { crearCliente, Bulkhead, ServicioNoDisponible, BulkheadLleno, esperar };
