# qq-mode-console

暴露 DSH 设置命名空间 **`qq-mode`**（`mode` / `ownerQQ`），供桥接把模式写穿到 DSH。
**只有 host 半**：没有浏览器 UI 卡片，模式仍通过桥接控制台切换。

## 命名空间为什么能被读写（DSH 0.2.0 起）

DSH 不再有 `ctx.settings.register()`。命名空间由下面三点推导，缺一即失败：

1. profile 的 `cordis.patch.yml` 里存在 **id 恰好等于 `qq-mode`** 的 loader entry
   —— 见本目录 `cordis.patch.yml`（不是包名 `qq-mode-console`）；
2. 该 entry 的模块导出 `Config`（schemastery schema）；
3. `Config` 至少一个字段带 `.extra('volatile', true)`（只保留 volatile 字段）。

`apply()` 在 0.2.0 下是空操作，只写一行诊断；**不要**照着旧注释把
`ctx.settings.register()` 加回来（0.2.0 会 TypeError）。

## 诊断

- `lib/index.js` 的 `diag()` 默认写 `%TEMP%\qq-mode-plugin.log`；
- 可用 `QQ_MODE_DIAG` 覆盖路径，设为空串关闭；
- 诊断包含 `event`、`pid`、`settings` 是否存在、是否检测到 0.1.x 的旧注册接口。

`npm run doctor` 的 `plugin-load` 只把「写日志的进程仍存活」的记录当作 DSH 已加载的证据；
测试/上次运行的残留会被标成警告。

## 验证

```text
npm run test:plugin        # Config、entry id、volatile、不再调用已删除 API
npm run probe:settings     # 活 DSH：命名空间在列且可写
npm run doctor             # live-qq-mode：命名空间 + mode/ownerQQ 字段
```

环境变化（DSH 升级、设置 seam 变化、profile 换位置）的处置见
[`docs/guides/PLUGIN_ENV_PLAYBOOK.md`](../../docs/guides/PLUGIN_ENV_PLAYBOOK.md#settings-namespace)。
