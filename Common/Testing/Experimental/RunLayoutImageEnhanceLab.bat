@echo off
REM Launches the Layout + Image-Enhance experimentation harness using the Agent's
REM virtualenv (which already has transformers, google-genai, imagehash,
REM python-dotenv, etc. installed). Pure experiment tool -- touches no app code.

setlocal
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%..\..\.."
set "VENV_PYTHON=%REPO_ROOT%\Agent\.venv\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
    echo Could not find the Agent virtualenv at:
    echo    %VENV_PYTHON%
    echo Create it / install Agent requirements first, then re-run.
    pause
    exit /b 1
)

"%VENV_PYTHON%" "%SCRIPT_DIR%LayoutImageEnhanceLab.py"
if errorlevel 1 pause
endlocal
