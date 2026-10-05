#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================================
蓝色大肥鱼 —— 本地语音识别脚本（faster-whisper，可选降级链路）
============================================================================

这个脚本是 main/local-whisper.js 里内置脚本的**可读版本**：主进程实际执行的是
JS 里那份等价的内联脚本（用 `python -c` 传入，避免"脚本被替换"的篡改路径）。
两份代码的输入输出协议必须保持一致：

    输入（stdin 一行 JSON）：
        {"audio": "<wav 绝对路径>", "model": "base", "modelDir": "<模型根目录>"}

    输出（stdout 一行 JSON）：
        {"ok": true,  "text": "识别文本", "model": "base"}
        {"ok": false, "code": "no-package"|"model-missing"|"no-audio"|"bad-audio"|"error",
         "message": "..."}

    退出码：0 成功 / 2 缺 faster-whisper / 3 缺模型 / 4 音频不可用 / 5 其它

设计约束（与需求一致）：
  - **只用 CPU**（device="cpu"、compute_type="int8"）；是否允许加载模型由主进程
    用 nvidia-smi 空闲显存判断（> 1.5GB），本脚本不做任何显存探测、不抢 GPU；
  - **绝不自动下载模型**：模型路径不存在就直接报 model-missing 退出；
  - **绝不调用任何本地大语言模型**：这里只有语音转文本；
  - 音频只读**路径**，不读环境变量、不联网、不写任何文件。

用法（人工自检）：
    python python-stt/whisper_asr.py --self-check
    echo {"audio":"D:\\a.wav","model":"base","modelDir":"..."} | python python-stt/whisper_asr.py
"""

import argparse
import json
import os
import sys
import wave

DEFAULT_MODEL = "base"


def fail(code, message=""):
    """按协议输出失败 JSON 并返回退出码。"""
    sys.stdout.write(json.dumps({"ok": False, "code": code, "message": message}, ensure_ascii=False))
    return 2 if code == "no-package" else 3 if code == "model-missing" else 4 if code in ("no-audio", "bad-audio") else 5


def self_check():
    """自检：只检查依赖与模型目录，不加载模型、不联网。"""
    report = {"python": sys.version.split()[0], "faster_whisper": False, "numpy": False}
    try:
        import numpy  # noqa: F401

        report["numpy"] = True
    except Exception:
        pass
    try:
        import faster_whisper  # noqa: F401

        report["faster_whisper"] = True
    except Exception:
        pass
    report["ready"] = bool(report["numpy"] and report["faster_whisper"])
    sys.stdout.write(json.dumps(report, ensure_ascii=False))
    return 0 if report["ready"] else 2


def transcribe(audio_path, model_name, model_dir):
    """读 wav → 归一化成 float32 单声道 → faster-whisper（CPU / int8）。"""
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except Exception:
        return fail("no-package")

    if not audio_path or not os.path.isfile(audio_path):
        return fail("no-audio")

    # 模型路径必须在 import 之后、加载之前判定：缺模型直接退出，绝不触发下载
    model_path = os.path.join(model_dir, model_name) if model_dir else model_name
    if os.path.isabs(model_path) and not os.path.isdir(model_path):
        return fail("model-missing")

    try:
        with wave.open(audio_path, "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            frames = handle.readframes(handle.getnframes())
        if width != 2:
            return fail("bad-audio")
        samples = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
        if channels > 1:
            samples = samples.reshape(-1, channels).mean(axis=1)

        model = WhisperModel(model_path, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(samples, language="zh", beam_size=1)
        text = "".join(segment.text for segment in segments).strip()
        sys.stdout.write(json.dumps({"ok": True, "text": text, "model": model_name}, ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001 - 任何异常都要变成协议内的失败码
        return fail("error", str(error)[:120])


def main():
    parser = argparse.ArgumentParser(description="蓝色大肥鱼本地语音识别（可选降级）")
    parser.add_argument("--self-check", action="store_true", help="只检查依赖是否安装，不加载模型、不联网")
    args = parser.parse_args()

    if args.self_check:
        return self_check()

    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except Exception:
        return fail("no-audio", "stdin 不是合法 JSON")

    return transcribe(
        payload.get("audio") or "",
        payload.get("model") or DEFAULT_MODEL,
        payload.get("modelDir") or "",
    )


if __name__ == "__main__":
    sys.exit(main())
