@echo off
rem MYHEALTH 사진 인식 중계 서버 실행 (Ollama가 켜져 있어야 함)
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
python gateway.py
pause
