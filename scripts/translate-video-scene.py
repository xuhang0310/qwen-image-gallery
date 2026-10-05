"""Offline CPU translation of scene directions; lyrics never enter this process."""
import json
import os
import re
import sys
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
import torch
from transformers import MarianMTModel, MarianTokenizer

torch.set_num_threads(4)
request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
directory = Path(sys.argv[1])
tokenizer = MarianTokenizer.from_pretrained(directory, local_files_only=True)
model = MarianMTModel.from_pretrained(directory, local_files_only=True).eval()
text = request["text"]
parts = re.split(r"(?<=[。！？；;\n])", text)
chunks = []
for part in parts:
    chunks.extend(part[i:i + 160] for i in range(0, len(part), 160) if part[i:i + 160].strip())
translated = []
with torch.inference_mode():
    for chunk in chunks:
        tokens = tokenizer(chunk, return_tensors="pt", truncation=False)
        if tokens.input_ids.shape[1] > 512:
            raise ValueError("Scene segment exceeds translation context")
        output = model.generate(**tokens, max_new_tokens=384, num_beams=4)
        translated.append(tokenizer.decode(output[0], skip_special_tokens=True))
result = " ".join(translated).strip()
if not result or re.search(r"[\u3400-\u9fff]", result):
    raise ValueError("Scene translation did not produce English directions")
sys.stdout.buffer.write(json.dumps({"text": result}, ensure_ascii=True).encode("utf-8"))
