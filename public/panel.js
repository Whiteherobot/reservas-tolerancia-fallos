const $ = (id) => document.getElementById(id);

const NOMBRES = {
  'api-gateway': 'API Gateway',
  reservas: 'Reservas',
  inventario: 'Inventario',
  pagos: 'Pagos',
  notificaciones: 'Notificaciones'
};

const dinero = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' });

function elemento(tag, props = {}, hijos = []) {
  const el = document.createElement(tag);
  Object.assign(el, props);
  for (const h of [].concat(hijos)) el.append(h);
  return el;
}

function registrar(texto, tipo = 'info') {
  const hora = new Date().toLocaleTimeString('es-EC');
  const linea = elemento('div', { className: `log-entry log-${tipo}` }, [
    elemento('span', { className: 'log-time', textContent: `[${hora}] ` }), texto
  ]);
  $('registro').append(linea);
  $('registro').scrollTop = $('registro').scrollHeight;
}

function avisar(texto, ok) {
  $('aviso-reserva').textContent = texto;
  $('aviso-reserva').className = `aviso ${ok ? 'ok' : 'error'}`;
}

async function pedir(url, opciones) {
  const r = await fetch(url, opciones);
  const datos = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, datos, headers: r.headers };
}

async function cargarCartelera() {
  const grid = $('cartelera');
  const { ok, datos, headers } = await pedir('/api/inventario').catch(() => ({ ok: false }));
  if (!ok) {
    grid.replaceChildren(elemento('p', { textContent: 'El inventario no responde y no hay copia de la cartelera.' }));
    return;
  }
  const edadCache = headers.get('X-Desde-Cache');
  grid.replaceChildren(...datos.map((ev) => tarjetaEvento(ev, edadCache)));

  for (const select of document.querySelectorAll('.select-evento')) {
    if (select.options.length) continue;
    for (const ev of datos.filter((e) => e.id !== 'evento-4')) {
      select.append(elemento('option', { value: ev.id, textContent: ev.nombre }));
    }
  }
  $('demo2-evento').value = 'evento-2';
}

function tarjetaEvento(ev, edadCache) {
  const correo = elemento('input', { type: 'email', placeholder: 'Correo', required: true, className: 'demo-input' });
  const asientos = elemento('input', { type: 'number', value: 1, min: 1, max: 10, required: true, className: 'demo-input' });
  // Con la cartelera en caché no se sabe cuántos asientos quedan de verdad.
  const boton = elemento('button', { type: 'submit', className: 'btn-book', textContent: 'Reservar', disabled: !ev.disponible || Boolean(edadCache) });
  const form = elemento('form', { className: 'booking-form' }, [correo, asientos, boton]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    reservar(ev, correo.value, Number(asientos.value), boton);
  });

  const tarjeta = elemento('div', { className: `event-card${edadCache ? ' from-cache' : ''}${ev.disponible ? '' : ' agotado'}` }, [
    elemento('div', { className: 'badge-resilience', textContent: `Copia de hace ${edadCache} s, inventario sin respuesta` }),
    elemento('div', { className: 'event-name', textContent: ev.nombre }),
    elemento('div', { className: 'event-price', textContent: dinero.format(ev.precio) }),
    elemento('div', { className: 'event-seats', textContent: ev.disponible ? `Quedan ${ev.asientosDisponibles} de ${ev.capacidad}` : 'Agotado' }),
    form
  ]);
  return tarjeta;
}

async function reservar(ev, usuario, asientos, boton) {
  boton.disabled = true;
  boton.textContent = 'Procesando...';
  try {
    const { status, datos } = await pedir('/api/reservas', {
      method: 'POST',
      // La misma clave permite reintentar sin reservar dos veces.
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ eventoId: ev.id, asientos, usuario })
    });
    if (status === 201) avisar(`Reserva confirmada: ${asientos} asiento(s) para ${ev.nombre}, total ${dinero.format(datos.monto)}.`, true);
    else if (status === 202) avisar('La pasarela de pagos está demorando. Los asientos quedan retenidos y la reserva se confirma sola cuando responda.', true);
    else avisar(datos.motivo || datos.error || `Error ${status}`, false);
  } catch {
    avisar('No se pudo contactar con el sistema de reservas.', false);
  } finally {
    boton.disabled = false;
    boton.textContent = 'Reservar';
    await cargarCartelera();
    cargarReservas();
  }
}

async function cargarReservas() {
  const { ok, datos } = await pedir('/api/reservas').catch(() => ({ ok: false }));
  if (!ok) return;
  const filas = datos.filter((r) => r.estado !== 'procesando').slice(0, 15).map((r) => {
    const acciones = elemento('td');
    if (['confirmada', 'pago-pendiente'].includes(r.estado)) {
      const cancelar = elemento('button', { className: 'btn-chico', textContent: 'Cancelar' });
      cancelar.addEventListener('click', async () => {
        cancelar.disabled = true;
        const res = await pedir(`/api/reservas/${r.id}`, { method: 'DELETE' });
        avisar(res.ok ? 'Reserva cancelada, pago reembolsado y asientos devueltos.' : (res.datos.error || 'No se pudo cancelar'), res.ok);
        cargarReservas();
        cargarCartelera();
      });
      acciones.append(cancelar);
    }
    return elemento('tr', {}, [
      elemento('td', { textContent: new Date(r.creada).toLocaleTimeString('es-EC') }),
      elemento('td', { textContent: r.usuario }),
      elemento('td', { textContent: r.eventoNombre ?? r.eventoId }),
      elemento('td', { className: 'num', textContent: r.asientos }),
      elemento('td', { className: 'num', textContent: r.monto ? dinero.format(r.monto) : '-' }),
      elemento('td', {}, elemento('span', { className: `estado estado-${r.estado}`, textContent: r.estado, title: r.motivo ?? '' })),
      acciones
    ]);
  });
  $('reservas').replaceChildren(...filas);
}

async function actualizarEstado() {
  const { ok, datos } = await pedir('/api/estado').catch(() => ({ ok: false }));
  if (!ok) {
    $('estado-sistema').textContent = 'Sin conexión';
    $('indicador-sistema').className = 'status-indicator status-offline';
    return;
  }
  const servicios = Object.entries(datos.servicios);
  const activos = servicios.filter(([, s]) => s.activo).length;
  const degradado = activos < servicios.length || datos.servicios.inventario.simulandoCaida
    || datos.servicios.pagos.latenciaMs > 0 || datos.breakers.reservas !== 'cerrado';
  $('estado-sistema').textContent = degradado ? 'Degradado' : 'Operacional';
  $('indicador-sistema').className = `status-indicator ${degradado ? 'status-offline' : 'status-online'}`;
  $('servicios-activos').textContent = `${activos}/${servicios.length}`;
  $('latencia').textContent = datos.latenciaP50 === null ? '-' : `${datos.latenciaP50} / ${datos.latenciaP95} ms`;
  $('solicitudes').textContent = datos.solicitudesUltimoMinuto;

  $('servicios').replaceChildren(...servicios.map(([nombre, s]) => {
    let detalle = s.activo ? 'activo' : 'no responde';
    if (s.simulandoCaida) detalle = 'caída simulada';
    if (s.latenciaMs > 0) detalle = `latencia ${s.latenciaMs / 1000} s`;
    return elemento('div', { className: 'service-item' }, [
      elemento('span', { className: 'service-name', textContent: NOMBRES[nombre] }),
      elemento('span', { className: 'service-status' }, [
        elemento('span', { className: `status-indicator ${s.activo && !s.simulandoCaida ? 'status-online' : 'status-offline'}` }),
        detalle
      ])
    ]);
  }));

  $('breaker-reservas').textContent = datos.breakers.reservas;
  $('breaker-inventario').textContent = datos.servicios.reservas.breakers?.inventario ?? '-';
  $('bulkhead').textContent = `${datos.bulkhead.activas} / ${datos.bulkhead.enCola}`;
  $('descartadas').textContent = datos.bulkhead.rechazadas;
  $('pendientes').textContent = datos.servicios.reservas.pendientes ?? '-';
  $('cache').textContent = `${datos.cacheInventario.aciertos} veces`;
}

function parametros(demo) {
  switch (demo) {
    case 'inventario-fantasma': return { eventoId: $('demo1-evento').value };
    case 'pasarela-lenta': return { eventoId: $('demo2-evento').value, asientos: Number($('demo2-asientos').value) };
    case 'diluvio-peticiones': return { usuarios: Number($('demo3-usuarios').value) };
    case 'condicion-carrera': return { usuarios: Number($('demo4-usuarios').value), asientos: Number($('demo4-asientos').value) };
    default: return {};
  }
}

async function ejecutarDemo(boton) {
  const demo = boton.dataset.demo;
  document.querySelectorAll('[data-demo]').forEach((b) => { b.disabled = true; });
  boton.textContent = 'Ejecutando...';
  $('registro').replaceChildren();
  registrar(`Demostración: ${boton.closest('.demo-card').querySelector('.demo-title').textContent}`);
  const reloj = setInterval(() => { actualizarEstado(); cargarCartelera(); }, 1000);
  try {
    const { ok, datos } = await pedir(`/demo/${demo}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parametros(demo))
    });
    if (!ok) throw new Error(datos.error || 'Falló la demostración');
    datos.pasos.forEach((p, i) => registrar(`${i + 1}. ${p.accion}: ${p.resultado}`, /NO (CUADRA|COINCIDE)/.test(p.resultado) ? 'error' : 'info'));
    registrar(`Patrones: ${datos.patrones.join(', ')}`, 'warn');
    registrar(datos.conclusion, 'info');
  } catch (error) {
    registrar(error.message, 'error');
  } finally {
    clearInterval(reloj);
    document.querySelectorAll('[data-demo]').forEach((b) => { b.disabled = false; });
    boton.textContent = 'Ejecutar';
    actualizarEstado();
    cargarCartelera();
    cargarReservas();
  }
}

document.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => ejecutarDemo(b)));
$('actualizar-cartelera').addEventListener('click', cargarCartelera);

registrar('Elija una demostración para provocar un fallo y ver cómo responde el sistema.');
cargarCartelera();
cargarReservas();
actualizarEstado();
setInterval(actualizarEstado, 3000);
setInterval(cargarReservas, 5000);
