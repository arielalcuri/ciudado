@echo off
title Cuidado Familiar - Monitoreo GPS, Ruta, Caidas y Camara Remota
cd /d "%~dp0"
echo =====================================================================
echo   INICIANDO SERVIDOR CUIDADO FAMILIAR (PUERTO 3050)
echo =====================================================================
start "" "http://localhost:3050"
node server.js
pause

