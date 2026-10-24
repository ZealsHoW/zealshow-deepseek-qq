#!/usr/bin/env python
"""启动 GPT-SoVITS 的 api_v2.py，并把自己的 PID 写到 state/gptsovits-serve.pid。

为什么要多这一层（2026-10-24）：
桥接在唱歌（ACE-Step）前要把这个服务停掉腾显存。它有两种状态：
  - 已经监听端口：能按端口（netstat）找到那个 python，杀掉就行；
  - 正在加载模型、还没监听端口：**按端口找不到它**，可这时它已经吃了好几个 GB，
    结果就是把 ACE-Step 挤成 `exit=3221225477`（0xC0000005 访问违例）。
所以要有一份「这个 python 的 PID」落到文件里。判断进程树（taskkill /T）或者查命令行
都要 WMI，而这台机器上 `Get-CimInstance` 会卡 20 秒以上（见 README「看门狗的探活不许用 WMI」），
所以最省事的办法是让 python 自己报 PID。

用法（由 scripts/gptsovits-serve.ps1 调用，参数原样转发给 api_v2.py）：
  python gptsovits-serve.py <api_v2.py 的绝对路径> [-a 127.0.0.1 -p 9880 -c ...]
"""
import os
import pathlib
import runpy
import sys

HERE = pathlib.Path(__file__).resolve().parent          # qq-bridge/scripts
PID_FILE = HERE.parent / 'state' / 'gptsovits-serve.pid'


def main():
    if len(sys.argv) < 2:
        print('用法：python gptsovits-serve.py <api_v2.py> [api_v2.py 的参数...]', file=sys.stderr)
        return 2
    api = pathlib.Path(sys.argv[1]).resolve()
    if not api.is_file():
        print(f'找不到 {api}', file=sys.stderr)
        return 2

    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding='ascii')
    # print 不是多余的：服务起不来时看日志能知道 PID 文件是谁写的
    print(f'[serve] pid={os.getpid()} → {PID_FILE}', flush=True)

    sys.argv = [str(api)] + sys.argv[2:]
    # `python api_v2.py` 会把脚本所在目录放在 sys.path[0]，runpy.run_path 不会——
    # 少了这一步 api_v2 立刻 `ModuleNotFoundError: No module named 'tools'`（2026-10-24 踩过）。
    if str(api.parent) not in sys.path:
        sys.path.insert(0, str(api.parent))
    try:
        # run_path 让 api_v2.py 以为自己就是主程序（argparse 读 sys.argv[1:]），
        # 但它跑在**本进程**里，所以 PID 文件里的号就是真正吃内存的那个 PID。
        runpy.run_path(str(api), run_name='__main__')
        return 0
    except SystemExit as exc:
        return int(exc.code or 0)
    finally:
        try:
            if PID_FILE.read_text(encoding='ascii').strip() == str(os.getpid()):
                PID_FILE.unlink()
        except (OSError, ValueError):
            pass


if __name__ == '__main__':
    sys.exit(main())