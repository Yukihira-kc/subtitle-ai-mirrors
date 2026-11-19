import argparse
import ctypes as c
import errno
import json
import os
from pathlib import Path
import secrets
import socket
import threading
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import time

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
import base64
import faulthandler
from concurrent.futures import ThreadPoolExecutor
lock = threading.Lock()
rec = None
LOCAL_ADDRESS = '127.0.0.1'
PORT = 39462
HOST = f'{LOCAL_ADDRESS}:{PORT}'
ORIGINS = {
    'https://subtitle-ai-mirrors.vercel.app',
    'https://subtitle-ai-mirrors-th6k36zl5ltja.azurewebsites.net',
}
PROTOCOL = 'caption-vosk'
IDLE_SECONDS = 10 * 60
owner = None
last_seen = 0
sid = None

sequence = 0
last_reply = None

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def reply(self, status, data, mime='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Vary', 'Origin')
        if self.allowed():
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Client, X-Session, X-Sequence')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()
        self.wfile.write(data)
    def allowed(self):
        return self.headers.get('Origin') in ORIGINS and self.headers.get('Host') == HOST

    def do_OPTIONS(self):
        self.reply(204 if self.allowed() else 403, b'')

    def do_GET(self):
        if self.path != '/ready' or not self.allowed():
            return self.reply(403,b'{}')
        self.reply(200, b'{"ready":true}')
    def do_POST(self):
        with lock:
            try:
                self.process_audio()
            except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):
                pass
            except Exception as exc:
                print("Recognition error:",repr(exc),flush=True)
                self.reply(500,json.dumps({'error':str(exc)}).encode())
    def process_audio(self):
        global rec, sid, sequence, last_reply, owner, last_seen
        client = self.headers.get('X-Client', '')
        if not self.allowed() or len(client) != 36:
            return self.reply(403,b'{}')
        size = int(self.headers.get('Content-Length','0'))
        if size < 0 or size > 2097152:
            return self.reply(413,b'{}')
        data = self.rfile.read(size)
        if self.path == '/start':
            if rec and owner != client and time.monotonic() - last_seen < 15:
                return self.reply(409,b'{"error":"Vosk is recording in another tab"}')
            owner, last_seen = client, time.monotonic()
            try: rate=int(data)
            except ValueError: return self.reply(400,b'{}')
            if not 8000<=rate<=192000: return self.reply(400,b'{}')
            def initialize():
                if rec:free(rec)
                handle=new(model,rate)
                if not handle:raise RuntimeError("recognizer init failed")
                words(handle,1)
                partial_words(handle,1)
                return handle
            rec=engine.submit(initialize).result()
            sid=secrets.token_hex(8)
            sequence,last_reply=0,None
            return self.reply(200,json.dumps({'sid':sid}).encode())
        if client != owner or self.headers.get('X-Session')!=sid or not sid: return self.reply(409,b'{}')
        last_seen = time.monotonic()
        number=int(self.headers.get('X-Sequence','-1'))
        if number==sequence-1 and last_reply is not None:return self.reply(200,last_reply)
        if number!=sequence or not rec:return self.reply(409,b'{}')
        ending=self.path=='/finish'
        if self.path=='/audio':
            data=base64.b64decode(data,validate=True)
            if not data or len(data)%2:return self.reply(400,b'{}')
        elif not ending:return self.reply(404,b'{}')
        def recognize():
            if ending:
                value=final(rec)
                free(rec)
            else:
                endpoint=accept(rec,data,len(data))
                if endpoint<0:raise RuntimeError("waveform rejected")
                value=result(rec) if endpoint else partial(rec)
            return json.loads(value)
        payload=engine.submit(recognize).result()
        if ending:rec=None
        sequence+=1
        last_reply=json.dumps(payload).encode()
        self.reply(200,last_reply)


class VoskServer(ThreadingHTTPServer):
    def server_bind(self):
        if os.name == 'nt':
            # An external-protocol click can arrive twice while the model is loading.
            self.allow_reuse_address = False
            self.allow_reuse_port = False
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def register_launcher():
    if os.name != 'nt':
        sys.exit('Vosk browser registration requires Windows.')
    import winreg
    pythonw = ROOT / 'runtime' / 'pythonw.exe'
    if not pythonw.is_file():
        sys.exit('Cannot find runtime\\pythonw.exe. Run Register-Vosk.cmd after extracting the ZIP.')
    bridge = Path(__file__).resolve()
    # The browser URI is deliberately omitted from the command. The handler
    # starts the fixed local server and never interprets URL data or flags.
    command = f'"{pythonw}" "{bridge}" --web'
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf'Software\Classes\{PROTOCOL}') as protocol:
        winreg.SetValueEx(protocol, '', 0, winreg.REG_SZ, 'URL:Vosk Desk')
        winreg.SetValueEx(protocol, 'URL Protocol', 0, winreg.REG_SZ, '')
        with winreg.CreateKey(protocol, r'shell\open\command') as handler:
            winreg.SetValueEx(handler, '', 0, winreg.REG_SZ, command)
    print('Vosk registration complete. Select the microphone start button in Firefox.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--web', action='store_true')
    mode.add_argument('--register', action='store_true')
    if os.name != 'nt':
        mode.add_argument('--test-origin')
    options = parser.parse_args()
    if options.register:
        register_launcher()
        sys.exit(0)
    if getattr(options, 'test_origin', None):
        ORIGINS.add(options.test_origin)

    # Reserve the port before loading the model so concurrent starts cannot
    # load a second copy of the model into memory.
    with VoskServer((LOCAL_ADDRESS, PORT), Handler, bind_and_activate=False) as server:
        try:
            server.server_bind()
        except OSError as exc:
            if exc.errno not in (errno.EADDRINUSE, 10048, 10013):
                raise
            print(f'Vosk port {PORT} is already in use.', flush=True)
            sys.exit(0)

        if sys.stderr is not None:
            faulthandler.enable()
        engine = ThreadPoolExecutor(max_workers=1)
        os.environ['OPENBLAS_NUM_THREADS']='1'
        if os.name == 'nt':
            dll_path = os.add_dll_directory(str(ROOT / 'engine'))
            lib = c.CDLL(str(ROOT / 'engine/libvosk.dll'))
        else:
            lib = c.CDLL(os.environ['VOSK_TEST_LIB'])

        def api(name, result, *args):
            fn = getattr(lib, 'vosk_' + name)
            fn.restype, fn.argtypes = result, list(args)
            return fn

        ptr, string, integer = c.c_void_p, c.c_char_p, c.c_int
        api('set_log_level', None, integer)(-1)
        model = api('model_new', ptr, string)(b'model')
        if not model:
            sys.exit('Cannot open the Japanese model. Extract the entire ZIP first.')
        new = api('recognizer_new', ptr, ptr, c.c_float)
        words = api('recognizer_set_words', None, ptr, integer)
        partial_words = api('recognizer_set_partial_words', None, ptr, integer)
        accept = api('recognizer_accept_waveform', integer, ptr, string, integer)
        result = api('recognizer_result', string, ptr)
        partial = api('recognizer_partial_result', string, ptr)
        final = api('recognizer_final_result', string, ptr)
        free = api('recognizer_free', None, ptr)

        server.server_activate()
        print('Vosk ready. Return to the desk page and start recognition.', flush=True)
        if options.web:
            server.timeout = 2
            last_seen = time.monotonic()
            while time.monotonic() - last_seen < IDLE_SECONDS:
                server.handle_request()
        else:
            server.serve_forever()
