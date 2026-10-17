# Los cuatro fallos

Cada fallo se provoca de verdad con los interruptores `/admin` de los servicios
(solo accesibles desde la red interna de Docker) y se puede repetir desde el
panel o con `node scripts/demo.js <nombre>`.

## 1. Inventario fantasma

**Qué pasa:** el servicio de inventario deja de responder.

**Riesgo:** vender asientos que no existen ("fantasma") o dejar a todos
esperando timeouts.

**Cómo responde el sistema:**

- Reservas consulta el inventario con timeout de 2 s y dos reintentos con espera
  exponencial. Si sigue fallando, el circuit breaker se abre y los pedidos
  siguientes fallan en milisegundos (503) sin tocar el inventario.
- El gateway sigue mostrando la cartelera desde la última copia buena, marcada
  como copia, y el panel desactiva el botón de reservar. La copia nunca se usa
  para vender.
- Pasados 5 s el breaker deja pasar una prueba; si sale bien se cierra solo.

**Antes:** si Redis fallaba, el inventario pasaba a una copia en memoria con los
valores iniciales y volvía a vender asientos ya vendidos. Un "sin asientos"
dentro del script de Redis se tomaba como caída de Redis y caía también en esa
copia. Ahora Redis es la única fuente: sin Redis, el inventario contesta 503.

## 2. Pasarela lenta

**Qué pasa:** la pasarela de pagos tarda 12 s en contestar.

**Riesgo:** usuarios colgados, o reintentos que cobran dos veces.

**Cómo responde el sistema:**

- Reservas espera el pago como máximo 5 s. Si no llega, responde **202** con la
  reserva en `pago-pendiente` y los asientos retenidos.
- El cobro es idempotente por reserva: repetir el pedido devuelve el mismo pago.
- Un conciliador revisa cada 3 s las reservas pendientes y pregunta a la
  pasarela: si se cobró, confirma y manda el correo; si se rechazó, devuelve los
  asientos. Si en 60 s no hay respuesta, anula el pago (o lo reembolsa si llegó a
  cobrarse) y devuelve los asientos.

**Antes:** la latencia simulada no se podía activar (el interruptor cambiaba una
variable de entorno que el servicio ya había leído). La demo decía que el pago
"se procesaba en segundo plano", pero la reserva se cancelaba y el pago, si
terminaba, quedaba cobrado sin reserva.

## 3. Diluvio de peticiones

**Qué pasa:** llegan decenas de reservas al mismo tiempo.

**Cómo responde el sistema:**

- **Rate limiting:** cada cliente puede crear 20 reservas por minuto; el resto
  recibe 429.
- **Bulkhead:** el gateway procesa 10 reservas a la vez y deja 20 en cola. Lo
  que no entra se rechaza al instante con 503 y `Retry-After` (load shedding),
  en lugar de acumular espera y memoria sin límite.
- Sin `Idempotency-Key` el gateway no reintenta un POST, para no duplicar
  reservas. El panel siempre manda la clave.

**Antes:** la cola del bulkhead no tenía límite, la demo llamaba a reservas
saltándose el gateway (así que el rate limiting nunca actuaba) y contaba
cualquier error como "en cola". Las métricas del panel eran números al azar.

## 4. Condición de carrera

**Qué pasa:** varios usuarios piden el último asiento a la vez.

**Cómo responde el sistema:** comprobar y descontar los asientos es un único
script Lua en Redis, atómico. Cada asignación queda guardada por id de reserva,
así que repetir el pedido no descuenta dos veces y devolver asientos dos veces
no crea asientos.

**Antes:** se usaba un lock distribuido (Redlock) por evento que se mantenía
durante todo el cobro (hasta 25 s) con una vida de 10 s: el lock vencía a mitad
del cobro y, mientras tanto, bloqueaba a todos los compradores del evento.
