# Monitor de rutas en tiempo real (BDB)

Extensión de Chrome que lee el avance de rutas del portal de Amazon Logistics
(ruta, driver, `X/Y stops`, `A/B deliveries`), lo actualiza cada 15 minutos y
muestra el % de avance **por driver** y **por estación**.

## Instalación (una sola vez)

1. Abre `chrome://extensions` en Chrome.
2. Activa **Modo de desarrollador** (arriba a la derecha).
3. Clic en **Cargar descomprimida** y elige la carpeta `extension` de este repositorio.

## Uso

1. Abre el portal de Amazon Logistics en la vista de rutas (la lista con `stops` / `deliveries`).
   Abre una pestaña por cada estación que quieras seguir.
2. Cuando cargan las rutas aparece un panel abajo a la derecha con:
   - % de paradas y % de entregas de la estación,
   - la tabla de drivers ordenada del menor avance al mayor,
   - **Δ15m**: paradas hechas desde el corte anterior.
3. Cada 15 minutos la extensión recarga esas pestañas y toma un corte nuevo.
   **No cierres las pestañas del portal** y mantén la sesión iniciada.
4. El botón **Tablero** (o el ícono de la extensión) abre la vista consolidada
   de todas las estaciones, con la tendencia de los últimos 15 min.

### Nombre de la estación

La extensión intenta detectar el código de estación (por ejemplo `DMX4`) en la página.
Si muestra `SIN-ESTACION` o un nombre incorrecto, haz clic sobre el nombre en el
panel y escríbelo. Se recuerda en esa pestaña.

### Otro dominio del portal

Por defecto funciona en `logistics.amazon.com` y `logistics.amazon.com.mx`.
Si tu portal usa otro dominio, agrégalo en `extension/manifest.json`
(`host_permissions` y `content_scripts.matches`) y recarga la extensión.

## Archivos

| Archivo | Qué hace |
|---|---|
| `extension/parser.js` | Lee las filas a partir del texto visible (no depende del HTML del portal) |
| `extension/content.js` | Espera las rutas, hace scroll si la lista es larga, guarda el corte y pinta el panel |
| `extension/background.js` | Recarga las pestañas registradas cada 15 min |
| `extension/dashboard.*` | Tablero consolidado por estación y driver |
| `test/parser-test.html` | Filas de ejemplo para probar el lector |
