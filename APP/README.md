# ZeckClips

Convierte vídeos largos (podcasts, directos, entrevistas, vídeos de YouTube) en clips verticales para TikTok, Reels y Shorts: encuentra los mejores momentos, encuadra la cara, pone subtítulos automáticos, escribe títulos y hashtags con IA y exporta MP4.

App de escritorio para **Windows, macOS (Intel y Apple Silicon: M1, M2, M3, M4…) y Linux**.

## Instalar

| Sistema | Archivo | Cómo |
|---|---|---|
| Windows 10/11 (64 bits) | `ZeckClips-x.y.z-win-x64.exe` | Doble clic e instalar. Si aparece «Windows protegió tu PC»: *Más información → Ejecutar de todas formas*. |
| Mac con Apple Silicon (M1, M2, M3, M4…) | `ZeckClips-x.y.z-mac-arm64.dmg` | Abre el .dmg y arrastra ZeckClips a Aplicaciones. |
| Mac con Intel | `ZeckClips-x.y.z-mac-x64.dmg` | Igual que arriba. |
| Linux (Ubuntu, Debian, Mint…) | `ZeckClips-x.y.z-linux-x64.deb` | `sudo apt install ./ZeckClips-*.deb` |
| Linux (cualquier distribución) | `ZeckClips-x.y.z-linux-x64.AppImage` | `chmod +x ZeckClips-*.AppImage` y ábrelo. |
| Linux ARM (Raspberry Pi 5, etc.) | `…-linux-arm64.deb` / `…-linux-arm64.AppImage` | Igual que arriba. |

**¿Qué Mac tengo?** Menú  → *Acerca de este Mac*: si pone «Chip Apple M…» es Apple Silicon; si pone «Procesador Intel…», Intel.

**Primera vez en Mac:** la app no está firmada con un certificado de Apple, así que macOS avisa de que «no puede verificar el desarrollador». Abre *Ajustes del Sistema → Privacidad y seguridad* y pulsa *Abrir igualmente*. Si dice que la app «está dañada», ejecuta en Terminal:

```bash
xattr -cr /Applications/ZeckClips.app
```

Todo viene incluido (ffmpeg y yt-dlp): no hay que instalar nada más. Los vídeos exportados se guardan en **Descargas/ZeckClips**.

## Generar los instaladores

Los instaladores de cada sistema se generan en ese sistema. **GitHub Actions** compila los tres y ejecuta las pruebas automáticamente para cada PR que modifique la aplicación. Los instaladores de PR se guardan como **Artifacts**, sin publicar ninguna versión.

Para publicar una versión de forma intencionada:

1. Actualiza `"version"` en `APP/package.json` y en `APP/package-lock.json`.
2. Integra los cambios en `main` después de superar las pruebas.
3. Crea y publica una etiqueta con esa versión (por ejemplo, `v1.0.3`).
4. Solo entonces el flujo *Instaladores* construye y publica los paquetes en **Releases**.

Los cambios en `main` y la ejecución manual *Actions → Instaladores → Run workflow* generan artefactos, pero **no publican una release** sin una etiqueta.

### En tu ordenador

Requiere [Node.js](https://nodejs.org) 20 o superior.

```bash
npm install
npm start            # abre la app en modo desarrollo
npm run dist:mac     # .dmg para Intel y Apple Silicon (solo en un Mac)
npm run dist:win     # instalador .exe (en Windows)
npm run dist:linux   # .AppImage y .deb (en Linux)
```

Los instaladores quedan en `dist/`. `npm run bins` descarga FFmpeg y yt-dlp si faltan o no coinciden con sus hashes SHA-256. Los archivos correctos se reutilizan **sin conexión a Internet**, de modo que `npm start` puede iniciarse sin red cuando ya estén instalados los binarios. La importación de vídeos de Internet, los modelos no descargados y las funciones de Claude siguen requiriendo conexión.

> **Nota:** el empaquetador no admite carpetas con `;` en la ruta (como `DESARROLLOs; JUEGOS-APPs-IA`). Para compilar en local, copia el proyecto a una ruta sin ese carácter o usa `npx electron-builder --mac -c.directories.output=/tmp/zeckclips-dist`.

## Estructura

| Archivo | Qué hace |
|---|---|
| `app/index.html` | La interfaz completa: clips, subtítulos, títulos, editor y exportación. |
| `server.js` | Servidor local: descarga vídeos por URL (yt-dlp) y convierte a MP4 (ffmpeg). También funciona solo con `npm run web` → http://localhost:5178 |
| `main.js` | App de escritorio (Electron): arranca el servidor y abre la ventana. |
| `scripts/fetch-bins.mjs` y `scripts/verified-binaries.mjs` | Descarga y comprueba versiones fijadas de FFmpeg y yt-dlp, con reutilización de binarios válidos y escritura atómica. |
| `build/icon.png` | Icono de la app (1024×1024). Sustitúyelo por tu logo y vuelve a compilar. |
| `.github/workflows/build.yml` | Genera los instaladores de Windows, Mac y Linux en GitHub. |

## Seguridad y privacidad

- El servidor escucha únicamente en `127.0.0.1` y valida Host, Origin, procedencia del navegador y una cabecera personalizada para las rutas API.
- Las descargas directas solo admiten URLs HTTP(S) públicas en puertos estándar; se verifican las IP al conectar y las redirecciones. No se admiten direcciones privadas ni servicios internos. `yt-dlp` se limita a plataformas de vídeo conocidas.
- Las descargas y cargas de vídeo están limitadas a 2 GiB. El límite no garantiza un consumo constante de CPU o RAM durante la conversión.
- La clave de Anthropic solo se utiliza **durante la sesión**: no se almacena en `localStorage`. Las peticiones se procesan por el backend local y este envía solo el texto a la API de Anthropic. La clave sigue estando temporalmente en memoria cuando se usa.
- Los ejecutables FFmpeg (`b6.1.1`) y yt-dlp (`2026.10.26`) se comprueban con hashes SHA-256 fijados en el código. Una versión nueva requiere actualizar expresamente la versión y sus hashes, con revisión de seguridad.
- Ejecuta las pruebas de regresión con `npm test`. GitHub Actions ejecuta pruebas y comprobaciones de sintaxis en los cambios y PR.

**Límites del modelo de amenazas:** las comprobaciones protegen contra solicitudes web no autorizadas y muchos tipos de SSRF, pero no son un sandbox frente a software malicioso que ya se ejecute en el mismo equipo. Las bibliotecas cargadas desde CDN siguen siendo una dependencia de confianza y los instaladores no están firmados digitalmente.

## Necesita internet para

- Descargar la IA de subtítulos (Whisper) la primera vez; después queda guardada.
- El detector de caras y las fuentes de los subtítulos.
- La IA de Claude (opcional, con tu clave de API de Anthropic).
- Traer vídeos por URL.

Usa solo vídeos que sean tuyos o que tengas permiso para usar.
