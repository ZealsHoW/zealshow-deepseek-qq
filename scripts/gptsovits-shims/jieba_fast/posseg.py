"""`jieba_fast.posseg` 的替代壳：转发到 `jieba.posseg`。

GPT-SoVITS 里是 `import jieba_fast.posseg as psg` 然后 `psg.lcut(seg)`，
所以这个子模块必须真的存在（不能只靠包里的属性）。
"""

from jieba.posseg import *  # noqa: F401,F403
import jieba.posseg as _posseg

lcut = _posseg.lcut
cut = _posseg.cut
dt = getattr(_posseg, "dt", None)