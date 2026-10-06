"""Fetch the pinned Beta_3_Lite model with resumable ranges and SHA-256 verification."""
import concurrent.futures
import hashlib
import json
import threading
import time
from pathlib import Path

import requests

NAME = "10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot_skip_edges.safetensors"
REVISION = "dbdd87944063bc01d8062bae1dba12212ca4061f"
SHA256 = "03962f1fe1724aad544a003dfe0807221021c9aff7b60467d20c141debcec767"
SIZE = 22513527856
TARGET = Path("D:/comfyui/models/diffusion_models") / NAME
PART = TARGET.with_suffix(".safetensors.part")
STATE = TARGET.with_suffix(".safetensors.ranges.json")
CHUNK = 32 * 1024 * 1024
URL = f"https://huggingface.co/cicalooo/10Eros-Max-h3-int8-convrot/resolve/{REVISION}/{NAME}"
LOCK = threading.Lock()


def digest(file):
    h = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(16 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


if TARGET.exists():
    if TARGET.stat().st_size != SIZE or digest(TARGET) != SHA256:
        raise RuntimeError("Existing model differs; refusing to overwrite it")
    print("Pinned model already verified", flush=True)
    raise SystemExit(0)

TARGET.parent.mkdir(parents=True, exist_ok=True)
completed = set(json.loads(STATE.read_text()) if STATE.exists() and PART.exists() else [])
if not PART.exists():
    with PART.open("wb") as stream:
        stream.truncate(SIZE)
with requests.get(URL, headers={"Range": "bytes=0-0"}, stream=True, timeout=(20, 60)) as response:
    response.raise_for_status()
    resolved_url = response.url
started = time.monotonic()


def fetch(index):
    start = index * CHUNK
    end = min(SIZE, start + CHUNK) - 1
    for attempt in range(10):
        try:
            with requests.get(resolved_url, headers={"Range": f"bytes={start}-{end}"}, stream=True, timeout=(20, 90)) as response:
                response.raise_for_status()
                if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{SIZE}":
                    raise RuntimeError("Incorrect byte range")
                written = 0
                with PART.open("r+b") as stream:
                    stream.seek(start)
                    for block in response.iter_content(1024 * 1024):
                        if written + len(block) > end - start + 1:
                            raise RuntimeError("Oversized byte range")
                        stream.write(block)
                        written += len(block)
                if written != end - start + 1:
                    raise RuntimeError("Incomplete byte range")
            with LOCK:
                completed.add(index)
                temporary = STATE.with_suffix(".tmp")
                temporary.write_text(json.dumps(sorted(completed)))
                temporary.replace(STATE)
                received = sum(min(CHUNK, SIZE - i * CHUNK) for i in completed)
                print(f"{received / 1e9:.2f}/{SIZE / 1e9:.2f} GB ({received / SIZE:.1%}), {time.monotonic() - started:.0f}s", flush=True)
            return
        except (requests.RequestException, RuntimeError) as error:
            print(f"Range {index}: {type(error).__name__}, retry {attempt + 1}", flush=True)
            if attempt == 9:
                raise RuntimeError(f"Range {index} failed") from None
            time.sleep(min(2 * (attempt + 1), 15))


indices = [i for i in range((SIZE + CHUNK - 1) // CHUNK) if i not in completed]
with concurrent.futures.ThreadPoolExecutor(max_workers=48) as pool:
    list(pool.map(fetch, indices))
print("Checking SHA-256...", flush=True)
if digest(PART) != SHA256:
    raise RuntimeError("Model hash mismatch; partial file retained for diagnosis")
PART.replace(TARGET)
print("Model downloaded and SHA-256 verified", flush=True)
