#!/usr/bin/env python3
"""Serve only the panel folder on loopback, optionally opening Google Chrome."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--open', action='store_true', help='Open the panel in Google Chrome')
parser.add_argument('--port', type=int, default=8765)
args = parser.parse_args()
directory = str(Path(__file__).resolve().parent / 'dist')
class PanelHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

handler = partial(PanelHandler, directory=directory)
try:
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
except OSError:
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
url = f'http://localhost:{server.server_port}'
print(f'USB bench: {url}\nKeep this window open. Press Ctrl+C to stop.', flush=True)
if args.open:
    try:
        subprocess.run(['open', '-a', 'Google Chrome', url], check=True)
    except (OSError, subprocess.CalledProcessError):
        print(f'Open {url} in desktop Google Chrome.', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    print('\nPanel server stopped.', flush=True)
finally:
    server.server_close()
