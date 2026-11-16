"""Windows DPAPI; plaintext is never returned or written to disk."""
import base64
import ctypes
from ctypes import wintypes
import json
import sys

class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_byte))]

def crypt(raw, decrypt=False):
    if sys.platform != 'win32':
        raise RuntimeError('This preview requires Windows DPAPI')
    buffer = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    result = Blob()
    api = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not api(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise RuntimeError('Credential encryption failed')
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        ctypes.windll.kernel32.LocalFree(result.data)

def protect(channel, identifier, value):
    if not isinstance(value, str) or not value.strip() or len(value)>8192 or any(c in value for c in '\r\n\0'):
        raise ValueError('Invalid credential')
    return base64.b64encode(crypt(json.dumps({'channel':channel,'id':identifier,'value':value.strip()}).encode('utf-8'))).decode('ascii')

def unprotect(channel, identifier, cipher):
    data=json.loads(crypt(base64.b64decode(cipher),decrypt=True))
    if data['channel']!=channel or data['id']!=identifier:
        raise ValueError('Credential owner mismatch')
    return data['value']

if __name__=='__main__':
    try:
        r=json.loads(sys.stdin.read(300000))
        if r['op']!='protect':raise ValueError('Unsupported operation')
        print(json.dumps({'cipher':protect(r['channel'],r['id'],r['value'])}))
    except Exception:
        sys.exit(1)
