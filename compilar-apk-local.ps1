# ==============================================================================
# Script para preparar y compilar CuidadoFamiliar.apk con 2do Plano Permanente
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

$javaDir = ".\android\app\src\main\java\com\familia\cuidadofamiliar"
if (-not (Test-Path $javaDir)) {
    New-Item -ItemType Directory -Force -Path $javaDir | Out-Null
}
Copy-Item ".\android-src\KeepAliveService.java" "$javaDir\KeepAliveService.java" -Force
Copy-Item ".\android-src\MainActivity.java" "$javaDir\MainActivity.java" -Force

$manifestPath = ".\android\app\src\main\AndroidManifest.xml"
if (Test-Path $manifestPath) {
    Write-Host "`n[3/4] Configurando Servicio en 2do Plano y Permisos en AndroidManifest.xml..." -ForegroundColor Yellow
    $manifest = Get-Content $manifestPath -Raw
    if ($manifest -notmatch "KeepAliveService") {
        $permissionsBlock = @"
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
    <application
"@
        $manifest = $manifest -replace "<application", $permissionsBlock
        $manifest = $manifest -replace "</application>", "    <service android:name=`.KeepAliveService` android:enabled=`true` android:exported=`false` android:foregroundServiceType=`location` />`n    </application>"
        Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
    }
}

Write-Host "`n[4/4] Verificando Java JDK y Android SDK para compilar .APK..." -ForegroundColor Yellow
$hasJava = $null -ne (Get-Command java -ErrorAction SilentlyContinue)
if (-not $hasJava) {
    Write-Host "AVISO: Java JDK 21 y Android SDK no estan instalados en esta PC." -ForegroundColor Magenta
    exit 0
}

Set-Location ".\android"
.\gradlew.bat assembleDebug
$apkOut = ".\app\build\outputs\apk\debug\app-debug.apk"
if (Test-Path $apkOut) {
    Copy-Item $apkOut "..\CuidadoFamiliar.apk" -Force
    Write-Host "`n¡EXITO! Tu APK fue generada en: $PSScriptRoot\CuidadoFamiliar.apk" -ForegroundColor Green
}
