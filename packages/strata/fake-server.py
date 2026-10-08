"""A local Strata protocol fixture; no model, network download or real service."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from serve.winjob import contain

ap = argparse.ArgumentParser()
ap.add_argument("--engine")
ap.add_argument("--config")
ap.add_argument("--host")
ap.add_argument("--port", type=int)
args = ap.parse_args()
cfg = json.loads(Path(args.config).read_text())
if cfg.get("fail"):
    sys.exit("fixture startup failed")
time.sleep(cfg.get("delay", 0))
child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(3600)"],
                         creationflags=subprocess.CREATE_NO_WINDOW)
assert contain(child)
requests = []
Path("starts.jsonl").open("a").write(json.dumps({"pid": os.getpid(), "child": child.pid}) + "\n")

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/crash":
            os._exit(0)
        elif self.path == "/health":
            self.reply({"service": "strata", "status": "ok", "loaded": False})
        elif self.path == "/v1/models":
            self.reply({"data": [{"id": "fixture-model", "meta": {"n_ctx": 4096},
                                  "architecture": {"input_modalities": ["text"]}}]})
        elif self.path == "/events":
            self.reply({"requests": requests, "pid": os.getpid(), "child": child.pid,
                        "console": bool(ctypes.windll.kernel32.GetConsoleWindow())})
        else:
            self.reply({}, 404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
        requests.append({"path": self.path, "body": body, "header": self.headers.get("X-Test")})
        if cfg.get("busy"):
            time.sleep(30)
        self.reply({"answer": "fixture answer", "pid": os.getpid(), "body": body}, cfg.get("status", 200))

ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
