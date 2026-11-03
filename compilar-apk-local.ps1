# ==============================================================================
# Script para preparar y compilar CuidadoFamiliar.apk en Windows
# ==============================================================================
$ErrorActionPreference = "Stop"

Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host "   PREPARANDO PROYECTO ANDROID APK - CUIDADO FAMILIAR        " -ForegroundColor Cyan
Write-Host "=============================================================" -ForegroundColor Cyan

Set-Location $PSScriptRoot

Write-Host "`n[1/4] Instalando dependencias de Node y Capacitor..." -ForegroundColor Yellow
npm install

if (-not (Test-Path ".\android")) {
    Write-Host "`n[2/4] Creando estructura nativa de Android con Capacitor..." -ForegroundColor Yellow
    npx cap add android
} else {
    Write-Host "`n[2/4] Sincronizando archivos web con el proyecto Android..." -ForegroundColor Yellow
    npx cap sync android
}

$manifestPath = ".\android\app\src\main\AndroidManifest.xml"
if (Test-Path $manifestPath) {
    Write-Host "`n[3/4] Configurando permisos de GPS, Ruta, Camara, Microfono y Pantalla Activa en AndroidManifest.xml..." -ForegroundColor Yellow
    $manifest = Get-Content $manifestPath -Raw
    if ($manifest -notmatch "android.permission.CAMERA") {
        $permissionsBlock = @"
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <application
"@
        $manifest = $manifest -replace "<application", $permissionsBlock
        Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
    }
}

Write-Host "`n[4/4] Verificando Java JDK y Android SDK para compilar .APK..." -ForegroundColor Yellow
$hasJava = $null -ne (Get-Command java -ErrorAction SilentlyContinue)
if (-not $hasJava) {
    Write-Host "AVISO: Java JDK 21 y Android SDK no estan instalados en esta PC." -ForegroundColor Magenta
    Write-Host "Opciones para obtener el archivo .APK:" -ForegroundColor White
    Write-Host "  A) Instalar hoy mismo como WebAPK desde Chrome en el celular abriendo la URL del servidor (sin necesitar Android Studio)." -ForegroundColor Green
    Write-Host "  B) Subir esta carpeta a GitHub (el archivo .github/workflows/build-apk.yml compilara la APK gratis en la nube)." -ForegroundColor Green
    Write-Host "  C) Si instalas Android Studio, ejecuta: npx cap open android -> Build -> Build APK(s)." -ForegroundColor Green
    exit 0
}

Set-Location ".\android"
.\gradlew.bat assembleDebug
$apkOut = ".\app\build\outputs\apk\debug\app-debug.apk"
if (Test-Path $apkOut) {
    Copy-Item $apkOut "..\CuidadoFamiliar.apk" -Force
    Write-Host "`n¡EXITO! Tu APK fue generada en: $PSScriptRoot\CuidadoFamiliar.apk" -ForegroundColor Green
}

