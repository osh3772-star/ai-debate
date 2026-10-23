@echo off
py -3 "%~dp0ui_server.py" --open
if errorlevel 1 pause
