#!/usr/bin/env node
// Corre una demostración desde la terminal: node scripts/demo.js pasarela-lenta
const base = process.env.GATEWAY || 'http://localhost:3000';
const nombre = process.argv[2];
const demos = ['inventario-fantasma', 'pasarela-lenta', 'diluvio-peticiones', 'condicion-carrera'];

if (!demos.includes(nombre)) {
  console.error(`Uso: node scripts/demo.js <${demos.join('|')}>`);
  process.exit(1);
}

(async () => {
  const r = await fetch(`${base}/demo/${nombre}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  const datos = await r.json();
  if (!r.ok) throw new Error(datos.error);
  console.log(`${datos.demo}\n`);
  datos.pasos.forEach((p, i) => console.log(`${i + 1}. ${p.accion}: ${p.resultado}`));
  console.log(`\nPatrones: ${datos.patrones.join(', ')}`);
  console.log(datos.conclusion);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
