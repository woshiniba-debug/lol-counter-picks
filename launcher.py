"""Desktop launcher for the LOL Counter Picks app.

Packaged with PyInstaller into a double-click Windows executable. It starts the
Flask server on a free local port, opens the default browser, and stays running
until the user closes the console window.

This is intentionally separate from `app.py`: `app.py` keeps its plain
`python app.py` dev workflow (debug + reloader), while this launcher runs the
server without the reloader — the reloader spawns a child process by re-running
the executable, which misbehaves inside a frozen build.
"""
from __future__ import annotations

import logging
import socket
import sys
import threading
import webbrowser

from app import app


def _find_free_port(preferred: int = 5000) -> int:
    """Return a bindable localhost port, preferring 5000 then a few fallbacks."""
    for port in (preferred, 5001, 5002, 5050, 8000):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    # Last resort: let the OS pick any free port.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    # Quiet Flask's default request logging; keep our own info line readable.
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    port = _find_free_port()
    url = f"http://127.0.0.1:{port}"

    # Open the browser shortly after the server starts accepting connections.
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    bar = "=" * 50
    print(bar)
    print("  英雄联盟 Counter 位克制查询")
    print(f"  已启动：{url}")
    print("  浏览器会自动打开此地址。")
    print("  关闭这个黑色窗口即可退出程序。")
    print("  （首次查询会自动用系统 Edge 通过 OP.GG 验证，稍等几秒）")
    print(bar)

    try:
        app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
