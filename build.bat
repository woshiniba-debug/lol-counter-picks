@echo off
REM ============================================================
REM  Build the LOL Counter Picks double-click Windows app.
REM  Output: dist\LOLCounter\LOLCounter.exe
REM ============================================================
echo [1/2] Installing build dependencies...
python -m pip install -r requirements.txt pyinstaller || goto :error

echo [2/2] Building executable with PyInstaller...
python -m PyInstaller --noconfirm --clean LOLCounter.spec || goto :error

echo.
echo Done! Run:  dist\LOLCounter\LOLCounter.exe
echo (The app uses your system Edge/Chrome to clear OP.GG's WAF, so no
echo  separate browser download is needed.)
goto :eof

:error
echo.
echo Build failed. See the output above.
exit /b 1
