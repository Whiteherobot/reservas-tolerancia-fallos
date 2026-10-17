#!/usr/bin/env node
// Levanta los cinco servicios en esta máquina (sin Docker). Necesita un Redis
// en REDIS_URL, por ejemplo: docker run -d -p 6379:6379 redis:7-alpine
const { spawn } = require('node:child_process');

const servicios = ['notificaciones', 'pagos', 'inventario', 'reservas', 'api-gateway'];
const entorno = { ...process.env };
delete entorno.PORT; // cada servicio usa su puerto por defecto (3000 a 3004)

const procesos = servicios.map((nombre) => {
  const proceso = spawn(process.execPath, [`services/${nombre}/index.js`], { cwd: __dirname, stdio: 'inherit', env: entorno });
  proceso.on('exit', (codigo) => {
    if (codigo) console.error(`${nombre} terminó con código ${codigo}`);
  });
  return proceso;
});

console.log('Panel en http://localhost:3000 (Ctrl+C para detener)');

process.on('SIGINT', () => {
  for (const p of procesos) p.kill('SIGTERM');
  process.exit(0);
});
