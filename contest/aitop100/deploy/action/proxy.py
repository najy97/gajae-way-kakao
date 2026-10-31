#!/usr/bin/env python3
"""Action API sidecar for the contest bot.

The persona calls http://action:8080/api/... with only the X-Aitop100-Test-Case-Id
header. This process adds the participant token (which the persona never sees),
forwards to the contest action server, and returns status and body unchanged.
The data reset endpoint is refused so a prompt-injected turn cannot wipe state.
Every call is logged as one line (method, path, TC id, status, ms) for auditing.

Customer media: judges send photos and voice as kakaocdn URLs in the message text,
but the persona has no general egress. Two endpoints fetch only from kakaocdn hosts:
  GET /media?url=<kakaocdn url>  -> the raw bytes (save to tmp/ and read the image)
  GET /stt?url=<kakaocdn url>    -> {"text": "..."} Korean transcript (local Whisper)
"""

import http.server
import json
import os
import sys
import time
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request

UPSTREAM = os.environ.get("ACTION_UPSTREAM", "https://gyodong-mall-action.aitop100.org").rstrip("/")
TOKEN = os.environ["ACTION_TOKEN"].strip()
TC_HEADER = "X-Aitop100-Test-Case-Id"
BLOCKED = {"/api/action-data/reset"}
TIMEOUT = 20
RETRIES = 2
BUDGET = 30  # seconds for all attempts of one action call
UA = "curl/8.5.0"
MEDIA_HOST_SUFFIX = ".kakaocdn.net"
MEDIA_MAX_BYTES = 25 * 1024 * 1024

_whisper = None
_whisper_lock = threading.Lock()
_stt_cache = {}


def whisper():
    global _whisper
    with _whisper_lock:
        if _whisper is None:
            from faster_whisper import WhisperModel

            _whisper = WhisperModel(
                os.environ.get("WHISPER_MODEL", "small"),
                device="cpu",
                compute_type="int8",
                download_root=os.environ.get("WHISPER_ROOT", "/models"),
            )
        return _whisper


def check_media_url(url):
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (host.endswith(MEDIA_HOST_SUFFIX) or host == MEDIA_HOST_SUFFIX[1:]):
        raise PermissionError("only https kakaocdn media urls are allowed")


class MediaRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_media_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_media(url):
    check_media_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.build_opener(MediaRedirectHandler()).open(req, timeout=TIMEOUT) as resp:
        data = resp.read(MEDIA_MAX_BYTES + 1)
        if len(data) > MEDIA_MAX_BYTES:
            raise ValueError("media too large")
        return data, resp.headers.get("Content-Type", "application/octet-stream")


def normalize_api_path(path):
    if "#" in path:
        raise ValueError("fragments are not allowed")
    bare, separator, query = path.partition("?")
    while True:
        decoded = urllib.parse.unquote(bare, errors="strict")
        if decoded == bare:
            break
        bare = decoded
    if not bare.startswith("/") or any(value in bare for value in ("#", "?", "\\", "..")):
        raise ValueError("unsafe path")
    bare = "/" + "/".join(part for part in bare.split("/") if part and part != ".")
    if not bare.startswith("/api/") or bare in BLOCKED:
        raise ValueError("not allowed")
    return urllib.parse.quote(bare, safe="/:@!$&'()*+,;=-._~") + separator + query


def read_response(resp, deadline):
    if isinstance(resp, urllib.error.HTTPError):
        resp = resp.fp
    chunks = []
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("upstream deadline exceeded")
        if resp.fp is not None:
            resp.fp.raw._sock.settimeout(min(TIMEOUT, left))
        chunk = resp.read1(64 * 1024)
        if time.monotonic() >= deadline:
            raise TimeoutError("upstream deadline exceeded")
        if not chunk:
            # read1() returns b"" on an early close even when Content-Length is not met;
            # read() used to raise IncompleteRead, so keep failing instead of passing a cut body.
            if getattr(resp, "length", None):
                raise ConnectionError(f"upstream closed with {resp.length} bytes missing")
            return b"".join(chunks)
        chunks.append(chunk)


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _reply(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _media(self):
        started = time.monotonic()
        parsed = urllib.parse.urlparse(self.path)
        url = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
        try:
            if parsed.path == "/media":
                data, ctype = fetch_media(url)
                self._reply(200, data, ctype=ctype)
                log("GET /media", 200, f"{len(data)}B", f"{(time.monotonic() - started) * 1000:.0f}ms", url)
                return
            text = _stt_cache.get(url)
            if text is None:
                data, _ = fetch_media(url)
                with tempfile.NamedTemporaryFile(suffix=os.path.splitext(parsed.path)[1] or ".m4a") as tmp:
                    tmp.write(data)
                    tmp.flush()
                    segments, _info = whisper().transcribe(tmp.name, language="ko", beam_size=1, vad_filter=True)
                    text = " ".join(s.text.strip() for s in segments).strip()
                _stt_cache[url] = text
            body = json.dumps({"text": text}, ensure_ascii=False).encode()
            self._reply(200, body)
            log("GET /stt", 200, f"{(time.monotonic() - started) * 1000:.0f}ms", url, text[:120])
        except PermissionError as err:
            self._reply(403, json.dumps({"code": "BLOCKED", "message": str(err)}).encode())
            log("GET", parsed.path, 403, url)
        except Exception as err:
            self._reply(502, json.dumps({"code": "MEDIA_ERROR", "message": str(err)}).encode())
            log("GET", parsed.path, 502, url, repr(err)[:200])

    def _forward(self, method):
        started = time.monotonic()
        path = self.path
        tc = self.headers.get(TC_HEADER, "")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        try:
            path = normalize_api_path(path)
        except ValueError:
            self._reply(403, json.dumps({"code": "BLOCKED", "message": "not allowed"}).encode())
            log(method, path, f"tc={tc}", 403, "blocked")
            return
        # Cloudflare in front of the action server bans Python's default User-Agent (error 1010).
        headers = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json", "User-Agent": UA}
        if tc:
            headers[TC_HEADER] = tc
        if body is not None:
            headers["Content-Type"] = "application/json"
        status, data, extra = 502, b'{"code":"UPSTREAM_ERROR"}', {}
        # One time budget for all attempts so a failing action still leaves the model time to answer.
        # POST changes state (refund, cancel, handoff): a timed-out POST may have been applied upstream,
        # so it is retried only on 503 (explicitly not processed), never on timeouts or 500/502.
        deadline = time.monotonic() + BUDGET
        retry_on = (500, 502, 503) if method == "GET" else (503,)
        for attempt in range(RETRIES + 1):
            left = deadline - time.monotonic()
            if left < 2:
                break
            req = urllib.request.Request(UPSTREAM + path, data=body, method=method, headers=headers)
            try:
                try:
                    resp = urllib.request.urlopen(req, timeout=min(TIMEOUT, left))
                except urllib.error.HTTPError as err:
                    resp = err
                with resp:
                    data = read_response(resp, deadline)
                    status = resp.status
                    if resp.headers.get("Retry-After"):
                        extra["Retry-After"] = resp.headers["Retry-After"]
            except Exception as err:  # network error: retry
                status, data = 502, json.dumps({"code": "UPSTREAM_ERROR", "message": str(err)}).encode()
                if method != "GET":
                    break
            if status not in retry_on or attempt == RETRIES:
                break
            delay = 0.5 * (attempt + 1)
            if deadline - time.monotonic() - delay < 2:
                break
            time.sleep(delay)
        self._reply(status, data, extra=extra)
        log(method, path, f"tc={tc}", status, f"{(time.monotonic() - started) * 1000:.0f}ms",
            (body or b"").decode("utf-8", "replace")[:300])

    def do_GET(self):
        if self.path.split("?", 1)[0] in ("/media", "/stt"):
            self._media()
        else:
            self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler)
    log("action proxy up ->", UPSTREAM)
    # Load the STT model before the first voice message so it never costs turn time.
    threading.Thread(target=whisper, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
