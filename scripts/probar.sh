#!/usr/bin/env bash
# Prueba de punta a punta con todo el docker compose levantado:
# corre las cuatro demostraciones por el gateway y verifica los resultados.
set -euo pipefail
G="${GATEWAY:-http://localhost:3000}"
fallos=0

demo() { curl -sf -X POST "$G/demo/$1" -H 'Content-Type: application/json' -d "${2:-{\}}"; }
ok() { echo "ok   $1"; }
mal() { echo "MAL  $1"; fallos=$((fallos + 1)); }

r=$(demo inventario-fantasma)
echo "$r" | grep -q 'no se vendió ningún asiento fantasma' && ok 'inventario caído: sin ventas fantasma' || mal 'inventario caído'
# 201, o 402 si el banco simulado rechazó la tarjeta (5 %): en ambos casos el inventario volvió a responder.
echo "$r" | grep -Eq '"resultado":"(201|402) ' && ok 'se recupera tras el breaker' || { mal 'recuperación'; echo "$r"; }

r=$(demo pasarela-lenta '{"latenciaMs":8000}')
echo "$r" | grep -q '202 en' && ok 'pasarela lenta: 202 sin esperar' || mal 'pasarela lenta: 202'
echo "$r" | grep -q 'pasó a \\"confirmada\\"\|pasó a \\"rechazada\\"' && ok 'el conciliador resolvió el pago' || mal 'conciliación'

r=$(demo diluvio-peticiones '{"usuarios":60}')
echo "$r" | grep -q 'limitadas (429)' && ok 'diluvio: rate limiting' || mal 'diluvio: 429'
echo "$r" | grep -q 'descartadas (503)' && ok 'diluvio: descarte por bulkhead' || mal 'diluvio: 503'

r=$(demo condicion-carrera '{"usuarios":20,"asientos":3}')
echo "$r" | grep -q 'sin sobreventa' && ok 'carrera: sin sobreventa' || mal 'carrera'

[ "$fallos" -eq 0 ] && echo 'Todo bien.' || { echo "$fallos verificación(es) fallaron"; exit 1; }
