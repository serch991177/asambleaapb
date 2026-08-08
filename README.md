# Frontend Angular — APB Súmate

## Desarrollo

```bash
npm install
npm start
```

La aplicación se abre en `http://localhost:4200` y usa `proxy.conf.json` para
conectarse con Laravel en `http://127.0.0.1:8000`.

La landing incluye un módulo de acreditación con cámara y respaldo por ingreso
manual. La cámara funciona en `localhost`; fuera del entorno local el sitio debe
publicarse con HTTPS. El lector QR se descarga de forma diferida únicamente
cuando el operador activa la cámara.

## Producción

```bash
npm run build
```

El despliegue oficial se ejecuta desde la raíz del repositorio:

```bash
docker compose -p asambleaapb -f docker-compose-prod.yml up -d --build
```

La imagen publica `dist/asamblea-nacional-angular/browser` mediante Nginx y
redirige `/api` hacia el servicio interno de Laravel. La clave introducida por
el operador se envía en `X-Scanner-Token` y debe coincidir con
`SCANNER_ACCESS_TOKEN` en el backend.

Consulta `../DEPLOYMENT.md` para la configuración de Jenkins, PostgreSQL y HTTPS.
