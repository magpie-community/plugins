import json
import os
from pathlib import Path
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_GET(self):
        data = json.dumps({"name": sys.argv[2] if len(sys.argv) > 2 else "magpie", "version": "fixture"}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
server = HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
if len(sys.argv) > 3:
    # Test-only ownership evidence is out of band, never part of the real HTTP contract.
    Path(sys.argv[3]).write_text(json.dumps({"pid": os.getpid()}), encoding="utf-8")
server.serve_forever()
