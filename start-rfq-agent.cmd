@echo off
title RFQ agent (close this window to stop)
cd /d "%~dp0"
echo Starting the RFQ agent. It checks the inbox every minute while this window is open.
echo Close this window (or press Ctrl+C) to stop it.
echo.
call npm run dev
echo.
echo The RFQ agent has stopped.
pause
