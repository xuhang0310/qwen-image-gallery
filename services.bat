@echo off
rem Qwen Image local services manager
rem Usage: services.bat [start^|stop^|restart^|status] [all^|comfy^|web]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0services.ps1" %*
