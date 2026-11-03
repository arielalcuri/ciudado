# ❤️ Cuidado Familiar — App / APK de Monitoreo Post-ACV

Aplicación integral diseñada para el cuidado familiar de adultos mayores o pacientes en recuperación de un ACV. Incluye en una sola plataforma:

1. **📍 GPS en Tiempo Real y Trazado de Ruta Completa:**
   - Registra coordenadas exactas, velocidad (km/h), precisión en metros y dibuja la **ruta recorrida (polilínea)** en un mapa interactivo.
2. **👥 Identificación de Familiares y Cálculo de Distancia:**
   - Muestra en el mismo mapa a tu mamá (marcador rojo) y a todos los familiares conectados (marcadores azules identificados por nombre), calculando automáticamente a cuántos metros/kilómetros está cada familiar de ella.
3. **🛡️ Geocercas (Zona Segura):**
   - Permite definir un perímetro seguro alrededor de la casa o clínica (100m, 250m, 500m, 1km). Si sale del área, dispara una alarma sonora y visual en el celular de los cuidadores.
4. **⚠️ Lectura de Movimientos y Detector de Caídas (Acelerómetro):**
   - Lee continuamente las fuerzas G ($m/s^2$) del teléfono para clasificar si está *En reposo*, en *Movimiento leve*, *Caminando/En traslado* o si sufrió un *Impacto brusco / Posible caída*.
   - Ante un impacto, inicia una cuenta regresiva hablada de 10 segundos con un botón gigante verde para cancelar si fue un falso positivo; si no responde, envía la alerta de emergencia a la familia y activa cámara/audio.
5. **📹 Cámara y Audio Remoto Bidireccional (Auto-Respuesta Manos Libres):**
   - Permite que el familiar active remotamente la cámara (frontal o trasera) y el micrófono del celular de Mamá **sin que ella tenga que tocar ningún botón**, para verla, escuchar el ambiente y hablarle por el altavoz.
   - Incluye transmisión WebRTC P2P en vivo más respaldo automático de cuadros de imagen para atravesar cualquier red móvil/Wi-Fi.
6. **🗣️ Altavoz de Voz Asistida (Text-to-Speech Remoto) y Timbre Localizador:**
   - Desde tu celular puedes tocar frases rápidas o escribir cualquier mensaje y el celular de tu mamá **lo dirá en voz alta y clara en español** y lo mostrará en letras gigantes en su pantalla.
7. **🚨 Botones Gigantes de Accesibilidad ("NECESITO AYUDA" / "ESTOY BIEN"):**
   - Ocupan toda la pantalla del celular de tu mamá para que pueda responder o pedir ayuda con un solo toque incluso con movilidad reducida.

---

## 🚀 Cómo iniciarla ahora mismo

### Opción A: Doble clic en Windows
Haz doble clic en [`iniciar-cuidado-familiar.bat`](./iniciar-cuidado-familiar.bat) o ejecuta desde la terminal:
```bash
node cuidado-familiar/server.js
```
Luego abre:
- En tu PC: `http://localhost:3050`
- En los celulares (en la misma red Wi-Fi): `http://172.20.10.2:3050` (o la IP local que muestra la consola al arrancar).

### Opción B: Instalar como App en Android hoy mismo (WebAPK)
1. Abre la dirección en **Google Chrome** en el celular Android.
2. Presiona el botón **"📲 Instalar App"** arriba a la derecha (o Menú de Chrome ⋮ → *"Instalar aplicación"*).

### Opción C: Generar el archivo `.APK` instalable
- **En la nube gratis (sin instalar Android Studio ni Java en tu PC):** Sube esta carpeta a un repositorio de GitHub; el archivo [`.github/workflows/build-apk.yml`](./.github/workflows/build-apk.yml) compilará automáticamente `CuidadoFamiliar-APK` en la pestaña *Actions*.
- **En tu PC:** Ejecuta [`compilar-apk-local.ps1`](./compilar-apk-local.ps1) con PowerShell.

