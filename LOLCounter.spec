# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the LOL Counter Picks desktop build.

Build with:  pyinstaller --noconfirm LOLCounter.spec
Output:      dist/LOLCounter/LOLCounter.exe  (onedir — double-click to run)

Notes
-----
- Bundles `templates/` and `static/` as data files (app.py resolves them via
  sys._MEIPASS when frozen).
- `collect_all("playwright")` pulls in Playwright's Node driver so the headless
  browser launch works inside the frozen app. We do NOT bundle a Chromium
  binary: waf.py launches the system Edge/Chrome (channel="msedge"/"chrome"),
  which every Windows machine has.
"""
from PyInstaller.utils.hooks import collect_all

pw_datas, pw_binaries, pw_hiddenimports = collect_all("playwright")

a = Analysis(
    ["launcher.py"],
    pathex=[],
    binaries=pw_binaries,
    datas=[
        ("templates", "templates"),
        ("static", "static"),
    ] + pw_datas,
    hiddenimports=["playwright.sync_api"] + pw_hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="LOLCounter",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,           # keep a console so the user can read status / close to quit
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="LOLCounter",
)
