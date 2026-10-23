// 哨兵模块：声明「本次进程是常驻 HTTP MCP 宿主（src/mcp-http-host.js）」。
//
// 必须在 import 三个 server 模块**之前**被 import —— ESM 按 import 语句顺序深度优先求值，
// 所以 mcp-http-host.js 把它放在第一行即可保证：三个 server 模块被求值时已经能看到哨兵，
// 于是它们只导出 buildServer()，不会各自去 connect 一个 stdio transport。
//
// 为什么用 globalThis 哨兵而不是 import.meta / process.argv 判断：
//   mcp-web-search-safe.js 的离线测试会把该文件塞进 vm 上下文执行，那里既没有 import.meta，
//   也不保证有 process；globalThis 一定有。哨兵缺失时三个模块走原 stdio 路径（旧行为）。
globalThis.__QQ_MCP_HTTP_HOST__ = true;
export const HTTP_MODE = true;