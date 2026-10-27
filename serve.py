"""Tiny static file server for the sim (standard library only).

Usage: python serve.py [port]
Port order: command line, SIM_PORT, RACK_PORT, 8137. Binds to 127.0.0.1 only.
Runs in the foreground until it is stopped.
"""
import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


def pick_port():
    for raw in (sys.argv[1] if len(sys.argv) > 1 else "", os.environ.get("SIM_PORT", ""), os.environ.get("RACK_PORT", "")):
        raw = raw.strip()
        if raw.isdigit() and 0 < int(raw) < 65536:
            return int(raw)
    return 8137


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows can map .js to text/plain through the registry; pin the types we need.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json",
        ".txt": "text/plain; charset=utf-8",
        ".cpp": "text/plain; charset=utf-8",
        ".jerryio": "application/json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        # always serve the latest files after a git pull
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404, "No directory listing")
        return None

    def translate_path(self, path):
        # never serve dot-folders such as .git
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if any(part.startswith(".") and part not in (".", "..") for part in clean.split("/")):
            return os.path.join(ROOT, "__blocked__")
        return super().translate_path(path)

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    port = pick_port()
    handler = functools.partial(Handler, directory=ROOT)
    try:
        httpd = Server(("127.0.0.1", port), handler)
    except OSError as e:
        print("Could not listen on port %d: %s" % (port, e), flush=True)
        return 1
    print("Waypoint serving %s" % ROOT, flush=True)
    print("Listening on http://127.0.0.1:%d/" % port, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
