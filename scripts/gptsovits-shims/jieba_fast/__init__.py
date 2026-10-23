"""jieba_fast 的替代壳：用纯 Python 的 jieba 顶上去。

为什么会有这个东西：GPT-SoVITS 的 requirements.txt 钉了 `jieba_fast`，而 PyPI 上
jieba-fast 只有源码包（没有 Windows 轮子），装它需要 MSVC 编译环境——这台机器没有装
Visual Studio Build Tools，所以 `uv pip install -r requirements.txt` 会以
`error: Failed to build jieba-fast==0.53` 收场。

jieba_fast 是 jieba 的 C 加速分支，接口一模一样，GPT-SoVITS 只用到了：
  * `jieba_fast.setLogLevel(...)`
  * `jieba_fast.posseg.lcut(...)`
  * `jieba_fast.cut_for_search(...)`
纯 Python 的 jieba 全都提供，只是慢一点；我们合成的是一两句短文本，慢一点无所谓。

这个目录由 scripts/gptsovits-serve.ps1 通过 PYTHONPATH（外加 site-packages 里的
`_gptsovits_shims.pth`）挂进解释器，见 README「真人音色（GPT-SoVITS，可选）」。
"""

from jieba import *  # noqa: F401,F403
import jieba as _jieba
import jieba.posseg as posseg  # noqa: F401  （让 `jieba_fast.posseg` 这个属性存在）

setLogLevel = _jieba.setLogLevel
cut_for_search = _jieba.cut_for_search
lcut = _jieba.lcut
cut = _jieba.cut
__version__ = getattr(_jieba, "__version__", "0-shim")