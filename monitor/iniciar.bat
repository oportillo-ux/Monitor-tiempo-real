@echo off
rem Arranca el monitor de clientes y el tablero (http://localhost:8080).
cd /d "%~dp0"
start "" http://localhost:8080
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" recolector.py
pause
