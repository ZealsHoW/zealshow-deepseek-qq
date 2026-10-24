#!/usr/bin/env python
"""从任意一段音频/视频里切出「能当 GPT-SoVITS 参考音频」的片段，并给出逐字一致的参考文本。

为什么需要它：GPT-SoVITS 是零样本克隆，音色由 refAudio（3~10 秒干净人声）+ refText
（与音频逐字一致的文本）决定。主人随手丢过来的往往是十几秒的视频/录音：
  - 可能是视频容器（h264 + aac），要先用 ffmpeg 抽音频；
  - 全程连续说话、没有静音缝（VAD 判成一整段），不能靠静音切；
  - 切短了要「恰好停在句号」，否则 refText 会带着半句话，克隆出来的音色发飘。

这个脚本做三件事：
  1. ffmpeg 抽成 32kHz 单声道 wav；
  2. funasr（paraformer-zh + fsmn-vad + ct-punc）拿整段转写；
  3. 按「句子占比」估算句末时刻，逐条转写候选片段，挑出「最长且结尾是句号」的那条。

只输出 JSON（给 scripts/clone-voice.mjs 解析），真正的 config 切换在那边做。

用法（一般不用直接调，用 npm run voice:clone）：
  python scripts/clone-voice.py --audio sound/x.wav
  python scripts/clone-voice.py --audio 视频.mp4 --min-sec 4 --max-sec 10
  python scripts/clone-voice.py --audio a.wav --out-dir audio/ref --json-only

环境变量：
  FFMPEG_PATH / FFPROBE_PATH  ffmpeg 的绝对路径（默认找 ../_gptsovits/ffmpeg/*/bin，再退回 PATH）
  HF_ENDPOINT                 权重源（默认 https://hf-mirror.com）
  HF_HUB_CACHE / HF_HOME      funasr 模型的缓存目录（默认 <仓库>/../_hf-cache）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

SENTENCE_END = "。！？!?"
BREAK_CHARS = SENTENCE_END + "，、；：,;"
PUNCT_RE = re.compile(r"[\s。，、；：！？…,.!?;:\"'“”‘’（）()《》\[\]【】—\-~]")


def ffmpeg_bin(name: str) -> str:
    """找 ffmpeg / ffprobe：环境变量 → 已知的 _gptsovits 目录 → PATH。"""
    env_key = f"{name.upper()}_PATH"
    explicit = os.environ.get(env_key)
    if explicit and Path(explicit).exists():
        return explicit
    for parent in (REPO.parent, REPO):
        for cand in parent.glob(f"_gptsovits/ffmpeg/*/bin/{name}.exe"):
            return str(cand)
        for cand in parent.glob(f"_gptsovits/ffmpeg/*/bin/{name}"):
            return str(cand)
    found = shutil.which(name)
    if found:
        return found
    raise SystemExit(f"找不到 {name}：设 {env_key} 指到可执行文件")


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def probe_duration(path: Path) -> float:
    r = run([ffmpeg_bin("ffprobe"), "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)])
    try:
        return float(r.stdout.strip().splitlines()[0])
    except Exception:
        raise SystemExit(f"ffprobe 读不出时长：{r.stdout}{r.stderr}")


def extract_wav(src: Path, dst: Path) -> None:
    r = run([ffmpeg_bin("ffmpeg"), "-y", "-v", "error", "-i", str(src),
             "-vn", "-ac", "1", "-ar", "32000", str(dst)])
    if r.returncode != 0:
        raise SystemExit(f"ffmpeg 抽音频失败：{r.stderr[-800:]}")


def cut(src: Path, dst: Path, start: float, secs: float) -> None:
    r = run([ffmpeg_bin("ffmpeg"), "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{secs:.3f}",
             "-i", str(src), "-ac", "1", "-ar", "32000", str(dst)])
    if r.returncode != 0:
        raise SystemExit(f"ffmpeg 切片段失败：{r.stderr[-800:]}")


def norm(text: str) -> str:
    return PUNCT_RE.sub("", text or "")


def load_models():
    from funasr import AutoModel  # 只有这一步依赖 _gptsovits 那个 venv

    t0 = time.time()
    asr = AutoModel(model="paraformer-zh", vad_model="fsmn-vad", punc_model="ct-punc",
                    hub="hf", disable_update=True)
    vad = AutoModel(model="fsmn-vad", hub="hf", disable_update=True)
    print(f"[clone] models ready in {time.time() - t0:.1f}s", file=sys.stderr, flush=True)
    return asr, vad


def vad_spans(vad, wav: Path) -> list[tuple[float, float]]:
    res = vad.generate(input=str(wav), max_single_segment_time=30000)
    raw = res[0].get("value") if res else None
    spans = []
    for item in raw or []:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            spans.append((float(item[0]) / 1000.0, float(item[1]) / 1000.0))
    if not spans:
        spans = [(0.0, probe_duration(wav))]
    return spans


def transcribe(asr, wav: Path) -> str:
    res = asr.generate(input=str(wav), batch_size_s=60)
    return (res[0].get("text") if res else "") or ""


def break_cut_lengths(full_text: str) -> set[int]:
    """全文里每个「断句处」（句号、逗号、顿号、冒号）的「去标点字符数」。

    不能只看切出来那段文本的最后一个字：ct-punc 会给任何输入补句号，「结尾是句号」永远成立；
    必须回到全文核对——这个长度的前缀是不是正好落在原文的断句处。
    句号算断句，逗号也算：连续说话的人十几秒里可能一个句号都在 10 秒窗口之外，
    那时切在逗号上比切在词中间好得多（真机：13.87 秒里唯一的句号在 11.5 秒以后）。
    """
    n = 0
    cuts = set()
    for ch in full_text:
        if not PUNCT_RE.match(ch):
            n += 1
        if ch in BREAK_CHARS:
            cuts.add(n)
    return cuts


def find_cut(asr, wav: Path, start: float, speech_secs: float, full_text: str,
             min_sec: float, max_sec: float, tmp: Path):
    """从上限往下扫（0.2 秒一档），找最长的、切出来正好停在断句处的片段。

    判据两条：切出来的转写要是全文的开头（防 ASR 跑偏），长度还要落在原文的断句位置；
    扫不到就退回「是全文开头」里最长的那条（文本对得上，只是断在词中间）。
    """
    full_norm = norm(full_text)
    targets = break_cut_lengths(full_text)
    floor = max(min_sec, 1.0)
    t = min(max_sec, speech_secs)
    best_any = None
    scans = 0
    while t >= floor and scans < 40:
        trial = tmp / f"trial-{scans}.wav"
        cut(wav, trial, start, t)
        text = (transcribe(asr, trial) or "").strip()
        scans += 1
        tn = norm(text)
        if text and tn and full_norm.startswith(tn):
            if len(tn) in targets:
                return (t, text, trial)
            if best_any is None:
                best_any = (t, text, trial)
        t = round(t - 0.2, 3)
    return best_any


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--audio", required=True, help="源音频或视频")
    ap.add_argument("--out-dir", default=str(REPO / "audio" / "ref"))
    ap.add_argument("--name", default=None, help="参考音频文件名（默认 <源文件名>-ref.wav）")
    ap.add_argument("--min-sec", type=float, default=4.0)
    ap.add_argument("--max-sec", type=float, default=10.0)
    ap.add_argument("--json-only", action="store_true")
    args = ap.parse_args()

    src = Path(args.audio).expanduser().resolve()
    if not src.exists():
        raise SystemExit(f"找不到音频：{src}")
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    duration = probe_duration(src)
    # 中间产物放系统临时目录：放在仓库里会让 git status 多出个 clone-voice-xxxx/；
    # ignore_cleanup_errors 是因为 Windows 上 funasr 有时还捏着 wav 句柄，删不掉不该让整次失败。
    with tempfile.TemporaryDirectory(prefix="qqb-clone-voice-", dir=tempfile.gettempdir(),
                                     ignore_cleanup_errors=True) as tmp:
        wav = Path(tmp) / "src-32k.wav"
        extract_wav(src, wav)

        asr, vad = load_models()
        spans = vad_spans(vad, wav)
        speech_start = max(0.0, spans[0][0] - 0.05)
        speech_end = min(duration, spans[-1][1])
        speech_secs = max(0.2, speech_end - speech_start)

        ref_name = args.name or f"{src.stem}-ref.wav"
        ref_path = out_dir / ref_name

        warn = None
        if speech_secs <= args.max_sec:
            # 整段就够短：直接用（保留句首尾，不硬切）
            cut(wav, ref_path, speech_start, speech_secs)
            ref_text = transcribe(asr, ref_path)
            chosen = round(speech_secs, 2)

        else:
            full_text = transcribe(asr, wav)
            picked = find_cut(asr, wav, speech_start, speech_secs, full_text,
                              args.min_sec, args.max_sec, Path(tmp))
            if picked is None:
                secs = min(args.max_sec, speech_secs)
                trial = Path(tmp) / "fallback.wav"
                cut(wav, trial, speech_start, secs)
                picked = (secs, transcribe(asr, trial), trial)
                warn = "转写和全文对不上（音频里可能有音乐/停顿异常），退回「最长且不超过上限」的切法"
            chosen, ref_text, blob = picked
            ref_path.write_bytes(Path(blob).read_bytes())

        if not (ref_text or "").strip():
            raise SystemExit("转写结果是空的：确认音频里有人声，或换一段")
        if chosen < args.min_sec:
            warn = warn or f"这段只有 {chosen:.1f} 秒，参考音频偏短，克隆出来可能不够稳"

        payload = {
            "ok": True,
            "source": str(src),
            "duration": round(duration, 2),
            "vadSpans": [[round(a, 2), round(b, 2)] for a, b in spans[:8]],
            "refAudio": str(ref_path),
            "refText": ref_text.strip(),
            "secs": round(chosen, 2),
            "warn": warn,
        }
        if not args.json_only:
            print(f"[clone] {ref_path.name} · {chosen:.1f}s · {ref_text.strip()}",
                  file=sys.stderr, flush=True)
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
