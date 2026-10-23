/**
 * qqb / engine / loop —— 直连引擎的对话回路（R-F）
 *
 * 一次唤醒的处理：把系统提示 + 唤醒提示交给模型 → 模型要么说话、要么要工具 →
 * 引擎自己把工具跑掉、把结果塞回去 → 直到它说话（或撞上步数上限）。
 *
 * **回退安全（fallbackSafe）是这里最要紧的语义。**
 * 这条链路会真的发消息（`qq_send_message` 等），一旦已经执行过工具，
 * 就绝不能因为「模型后面失败了」再回退去跑 DSH preset —— 那等于把消息发两遍。
 * 所以：
 *   - 一个工具都没执行过 ⇒ `fallbackSafe: true`，调用方可以放心回退；
 *   - 执行过任何工具   ⇒ `fallbackSafe: false`，调用方只能记日志、放弃这一轮。
 *
 * 0.1.2 起支持 `toolLog` 钩子：每执行一个工具就回调两条条目（`type:'call'` 与
 * `type:'result'`），字段与桥接侧 DSH 链路写 `state/tool-calls.jsonl` 的格式一致，
 * 并额外带 `source:'engine'` 与 `purpose`。**之前引擎的统计只在内存里**
 * （`createAgentLoop().stats()`），进程一重启就归零，落盘的日志只有 DSH 那条链路在写——
 * 引擎一接管主链路，这份日志就整段变黑，事后答不出「她今天调了哪些工具、失败了几次」。
 * 钩子抛错只记日志、绝不影响这一轮（日志写不进去不能把对话拖垮）。
 *
 * 0.1.4 起两条「别哑掉」的护栏：
 *   1. 工具**连续失败** `maxFailedToolCalls` 次就不再让它试了（见 DEFAULT_MAX_FAILED_TOOL_CALLS）；
 *   2. 步数用尽还没说话时，再要一次**不带工具**的回复（`rescued: true` 时照常说话）。
 * 没护栏之前，工具一坏这一轮就是空烧 20～40 秒后一声不吭，日志里只留一句
 * 「达到最大步数（4 步）还没说话」，**查不出是哪个工具在坏**；现在失败的工具与次数
 * 会写进 error 文本，救援成功则照常发言。
 *
 * 0.1.5 起把**工具取回来的图片真的送到模型眼前**：
 * OpenAI 兼容协议里 `role:'tool'` 的消息只能放文本，所以图片不能塞在工具消息里。
 * 惯例做法是紧跟一条 `role:'user'` 的多模态消息（text + image_url），模型才真的看得见。
 * 在那之前工具箱把图片压成了 `[图片]` 三个字 ⇒ 她「看不见图」，还会回避图片话题。
 */

export const VERSION = '0.1.6';

/** 默认最多几轮「模型→工具→模型」。 */
export const DEFAULT_MAX_STEPS = 4;

/** 单轮里最多执行几个工具（模型偶尔一次要一堆，别被它牵着走）。 */
export const DEFAULT_MAX_TOOL_CALLS = 4;

/**
 * 工具连续失败几次就不再让它试了。
 *
 * 工具连着坏的时候，模型只会换着法子重试（改参数、换个工具再来），一路把步数烧光，
 * 最后必然是「达到最大步数还没说话」——**她直接哑掉**。2026-10-21 那四次就是这么发生的：
 * 看图工具因为少注入 key/token 全在报错，模型依次试了 describe_image → get_message_images
 * → 再 describe_image，空烧 20～40 秒，一个字都没说。
 */
export const DEFAULT_MAX_FAILED_TOOL_CALLS = 3;

/**
 * 拼消息：system（可为空）+ 历史 + 本轮 user。
 * @param {{system?: string, user?: string, history?: object[]}} input
 */
export function composeMessages(input = {}) {
  const messages = [];
  const system = typeof input.system === 'string' ? input.system.trim() : '';
  if (system) messages.push({ role: 'system', content: system });
  const history = Array.isArray(input.history) ? input.history : [];
  for (const item of history) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'assistant' || item.role === 'system' ? item.role : 'user';
    const content = String(item.content ?? '');
    if (!content) continue;
    messages.push({ role, content });
  }
  const user = typeof input.user === 'string' ? input.user : '';
  if (user) messages.push({ role: 'user', content: user });
  return messages;
}

/**
 * 把会话参数补进工具参数：schema 里要 `key`/`token`，但模型看不到它们（toolbox 已摘掉）。
 * 模型给了就用模型的，没给才补。
 *
 * 名单取 `entry.session`（toolbox 按 **schema 声明过的属性** 算出来的），不是 `entry.required`：
 * key/token 在很多工具里是可选属性，按 required 判会漏补——0.1.3 修的正是这个 bug
 * （`qq_describe_image` 一个 required 都没有 ⇒ key/token 都补不进 ⇒ 她 10 次看图 10 次失败）。
 * `entry.required` 只作为旧形状的兜底保留。
 */
export function injectArgs(entry, args, extra = {}) {
  const out = { ...(args && typeof args === 'object' ? args : {}) };
  const names = Array.isArray(entry?.session) ? entry.session : (Array.isArray(entry?.required) ? entry.required : []);
  for (const name of names) {
    if (out[name] === undefined && extra[name] !== undefined) out[name] = extra[name];
  }
  return out;
}

/** 安全的 JSON 解析：模型的 arguments 是字符串，偶尔会写出半截 JSON。 */
function parseArgs(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
    return { ok: false, error: '工具参数必须是对象' };
  } catch (error) {
    return { ok: false, error: `工具参数不是合法 JSON：${error?.message ?? error}` };
  }
}

/**
 * 把执行过的工具收敛成一句「哪些在坏」，用于失败日志与 error 文本。
 * @param {Array<{name: string, ok: boolean}>} list
 * @returns {string} 例如 `qq_describe_image×2、qq_get_message_images×1`；全成功返回 ''
 */
export function summarizeFailures(list = []) {
  const failed = new Map();
  for (const item of list) {
    if (!item || item.ok) continue;
    const name = String(item.name ?? '');
    failed.set(name, (failed.get(name) ?? 0) + 1);
  }
  return [...failed.entries()].map(([name, count]) => `${name}×${count}`).join('、');
}

/**
 * 模型原生工具调用标记的前缀。
 *
 * 两种都见过：`antml:`（Anthropic 风格）与 `｜DSML｜`（**DeepSeek 原生**——2026-10-22 00:25
 * 她发进 QQ 的正是这一种：U+FF5C 竖线包着 `DSML`）。前缀之后 `tool ` 可有可无。
 */
const CALL_TAG_PREFIX = '(?:antml:|[｜|]\\s*DSML\\s*[｜|]\\s*)?(?:tool[\\s_]+)?';

/** 造一条认这些标记的正则（`<` 与标签名之间允许空白）。 */
function callTagRe(body, flags = 'gi') {
  return new RegExp(`<\\s*${CALL_TAG_PREFIX}${body}`, flags);
}

/** 「这看起来像是把工具调用写成了正文」——包裹标签或 invoke 起始标签任一条命中即可。 */
const TEXT_CALL_HINT = callTagRe('(?:calls|invoke)\\b', 'i');
/** 整段包裹的调用块（含包裹标签本身）。 */
const TEXT_CALL_BLOCK = callTagRe(`calls\\s*>[\\s\\S]*?<\\s*\\/\\s*${CALL_TAG_PREFIX}calls\\s*>`);
/** 没有包裹标签时的单个 invoke 块。 */
const TEXT_INVOKE_BLOCK = callTagRe(`invoke\\s+name="[^"]*"\\s*>[\\s\\S]*?<\\s*\\/\\s*${CALL_TAG_PREFIX}invoke\\s*>`);
/**
 * 兜底：正文被截断（或模型忘了闭合）时，闭合标签对不上，上面两条块级正则就整段匹配不到。
 * 那就退一步，把剩下的零散标记本身也抹掉——只在 HINT 命中时才跑，普通句子碰不到。
 */
const TEXT_CALL_TAG_ONLY = new RegExp(
  `<\\s*(?:\\/\\s*)?${CALL_TAG_PREFIX}(?:calls|invoke|parameter)\\b[^>]*>`,
  'gi',
);

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 参数值：标了 string="true" 就原样；看着像 JSON 数字/布尔/对象就转，否则当字符串。 */
function coerceTextParam(raw, forceString) {
  const text = String(raw ?? '').trim();
  if (forceString) return text;
  if (!/^[[{"-]|^(?:true|false|null)$|^-?\d/.test(text)) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

  /**
 * 模型偶尔不走 tool_calls 协议，而是把它**原生**的工具调用标记直接写进正文。
 *
 * 2026-10-22 00:25 真发生过：她（唤醒原因 browse，屋里没人在说话）回了一整段这样的标记
 * ——DeepSeek 原生 DSML：包裹标签是「尖括号 + 全角竖线 + DSML + 全角竖线 + 空格 + calls」，
 * 里面一条条 invoke name / parameter name。桥接把它当成一句话**发进了 QQ**，
 * 主人收到的就是一堆标记。她其实是想看图，只是格式走岔了：DSML 是它的原生写法，
 * 而这条链路讲的是 OpenAI 的 tools/tool_calls。
 *
 * 兜底把它翻回真正的工具调用（也认 Anthropic 风格的 antml: 前缀），参数按名字取。
 * 认不出来就返回空数组，正文一个字不动。
 *
 * @param {string} text
 * @returns {Array<{id: string, name: string, arguments: string}>}
 */
export function parseTextToolCalls(text) {
  const raw = String(text ?? '');
  if (!raw || !TEXT_CALL_HINT.test(raw)) return [];
  const calls = [];
  const invokeRe = callTagRe('invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\s*\\/\\s*' + CALL_TAG_PREFIX + 'invoke\\s*>');
  let m;
  while ((m = invokeRe.exec(raw)) !== null) {
    const name = String(m[1] ?? '').trim();
    if (!name) continue;
    const args = {};
    const paramRe = callTagRe('parameter\\s+name="([^"]+)"([^>]*)>([\\s\\S]*?)<\\s*\\/\\s*' + CALL_TAG_PREFIX + 'parameter\\s*>');
    let p;
    while ((p = paramRe.exec(m[2] ?? '')) !== null) {
      const field = String(p[1] ?? '').trim();
      if (!field) continue;
      args[field] = coerceTextParam(decodeXmlEntities(p[3]), /string\s*=\s*"true"/i.test(p[2] ?? ''));
    }
    calls.push({ id: `text_call_${calls.length + 1}`, name, arguments: JSON.stringify(args) });
  }
  return calls;
}

/**
 * 把正文里那堆原生标记抹掉（翻成真调用之后就没人该看到它们了）。
 * 它同时是发给 QQ 的最后一道闸：{@link sanitizeEngineReplyV2} 也会调它。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTextToolCalls(text) {
  const raw = String(text ?? '');
  if (!raw || !TEXT_CALL_HINT.test(raw)) return raw;
  let out = raw
    .replace(TEXT_CALL_BLOCK, '')
    .replace(TEXT_INVOKE_BLOCK, '');
  // 还有残留（正文被截断、或模型忘了闭合，块级正则整段匹配不到）：从第一个残留标记起全丢掉。
  // 宁可这一轮少说半句话，也不能把标记发进聊天窗口——这正是 2026-10-22 那次事故的样子。
  const leftover = out.search(TEXT_CALL_HINT);
  if (leftover >= 0) out = out.slice(0, leftover);
  return out
    .replace(TEXT_CALL_TAG_ONLY, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {object} options
 * @param {object} options.model createModelClient() 的返回值
 * @param {object} options.toolbox createToolbox() 的返回值
 * @param {object} [options.logger] { warn }
 * @param {number} [options.maxSteps]
 * @param {number} [options.maxToolCalls]
 * @param {number} [options.maxFailedToolCalls]
 *   工具**连续**失败到这个次数就停手，改为直接要一句话（默认 3）
 * @param {(entry: object) => void} [options.toolLog]
 *   工具调用落盘钩子：每执行一个工具回调两条条目（`type:'call'` / `type:'result'`）。
 *   由宿主注入（桥接传 `core/call-log` 的 `append`），引擎自己不碰文件系统。
 */
export function createAgentLoop(options = {}) {
  const { model, toolbox, logger = null, maxSteps = DEFAULT_MAX_STEPS, maxToolCalls = DEFAULT_MAX_TOOL_CALLS, maxFailedToolCalls = DEFAULT_MAX_FAILED_TOOL_CALLS, catalogFilter = null, toolLog = null } = options;
  const stats = { runs: 0, ok: 0, failed: 0, fallbacks: 0, steps: 0, toolCalls: 0, executions: 0, byTool: {} };

  function warn(message, detail) {
    logger?.warn?.(message, detail ?? '');
  }

  /** 回调一次落盘钩子；钩子坏掉只警告，绝不影响这一轮对话。 */
  function emitToolLog(hook, entry) {
    if (typeof hook !== 'function') return;
    try {
      hook(entry);
    } catch (error) {
      warn('直连引擎：写工具调用日志失败', error?.message ?? error);
    }
  }

  /**
   * @param {object} request
   * @param {string} request.system 系统提示（人格卡 + 状态 + 记忆）
   * @param {string} request.user 本轮唤醒提示
   * @param {object[]} [request.history] 可选历史消息
   * @param {object} [request.extraArgs] 注入给工具的会话参数（key/token）
   * @param {boolean} [request.useTools] 默认 true
   * @param {number} [request.maxSteps]
   * @param {string} [request.purpose]
   * @param {(name: string, args: object, entry: object|undefined) => any} [request.intercept]
   *   主机侧拦截：对某个工具调用返回非空对象即当作它的执行结果（不去 MCP 真发）；
   *   返回 null/undefined 表示不拦，照常走工具箱。用于「模型可以调用、但由桥接决定怎么落地」
   *   的通道（直连引擎的表情/图片意向就是这么接的）。
   */
  async function run(request = {}) {
    stats.runs += 1;
    const purpose = String(request.purpose || 'qq-direct');
    const limit = Math.max(1, Number(request.maxSteps) || maxSteps);
    const useTools = request.useTools !== false;
    const extraArgs = request.extraArgs && typeof request.extraArgs === 'object' ? request.extraArgs : {};
    const messages = composeMessages(request);
    const transcript = messages.map((item) => ({ ...item }));
    const executed = [];
    // 落盘钩子：默认用建回路时给的那个，单轮可覆盖。key 从注入参数里取，方便按会话翻日志。
    const logHook = typeof request.toolLog === 'function' ? request.toolLog : toolLog;
    const logKey = String(extraArgs.key ?? '');
    let steps = 0;
    let lastText = '';
    let usage = null;
    let finishReason = '';
    let error = '';
    // 连续失败计数：工具连着坏时不再空烧步数（见 DEFAULT_MAX_FAILED_TOOL_CALLS）。
    const failedLimit = Math.max(1, Number(request.maxFailedToolCalls) || maxFailedToolCalls);
    let failedStreak = 0;

    const tools = useTools
      ? toolbox.catalog().filter((spec) => (typeof catalogFilter === 'function' ? catalogFilter(spec, toolbox.find(spec?.function?.name)) !== false : true))
      : [];

    /**
     * 救援：步数用尽时再要一次**不带工具**的回复。
     *
     * 她这一轮本来会一声不吭（用户听到的就是「不活泼」），多花一次模型调用换一句人话，
     * 比沉默划算。任何异常都返回 ''，绝不把已经记好的统计/日志带崩。
     */
    async function rescueWithText() {
      try {
        const res = await model.complete({
          messages: messages.concat([{
            role: 'user',
            content: '（系统提示）工具这条路走不通了，不要再调用任何工具。请直接用你已经知道的信息，简短地回一句人话。',
          }]),
          purpose: `${purpose}:rescue`,
          ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        });
        return res?.ok ? String(res.text ?? '').trim() : '';
      } catch (err) {
        warn('直连引擎：救援回复失败', err?.message ?? err);
        return '';
      }
    }

    for (let step = 1; step <= limit; step += 1) {
      steps = step;
      stats.steps += 1;
      const res = await model.complete({
        messages,
        ...(tools.length ? { tools } : {}),
        purpose,
        ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      });
      if (!res?.ok) {
        error = res?.error ?? '模型调用失败';
        stats.failed += 1;
        warn(`直连引擎：第 ${step} 步模型调用失败`, error);
        const safe = executed.length === 0;
        if (safe) stats.fallbacks += 1;
        return {
          ok: false,
          error,
          text: lastText,
          steps,
          toolCalls: executed,
          usage,
          finishReason,
          fallbackSafe: safe,
          transcript,
        };
      }
      usage = res.usage ?? usage;
      finishReason = res.finishReason ?? finishReason;
      const calls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
      lastText = String(res.text ?? '');

      // 模型偶尔把工具调用按它自己的 XML 方言写进正文（而不是走 tool_calls 协议）。
      // 2026-10-22 00:25 就是这样：那段 `<tool calls>…` 原文被当成一句话发进了 QQ。
      // 这里翻译回真正的调用，并把正文里那段标签抹掉——她想调的工具照样会跑。
      if (!calls.length) {
        const textCalls = parseTextToolCalls(lastText);
        if (textCalls.length) {
          warn(`直连引擎：模型把工具调用写成了正文（${textCalls.map((c) => c.name).join('、')}），已按调用处理`);
          lastText = stripTextToolCalls(lastText);
          calls.push(...textCalls);
        }
      }

      if (!calls.length) {
        stats.ok += 1;
        return {
          ok: true,
          text: lastText,
          steps,
          toolCalls: executed,
          usage,
          finishReason,
          fallbackSafe: false,
          transcript,
        };
      }

      // 把模型要的工具调用原样记进对话（OpenAI 要求 assistant 带 tool_calls）
      const assistantMessage = {
        role: 'assistant',
        content: lastText,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
      messages.push(assistantMessage);
      transcript.push({ ...assistantMessage });

      const pick = calls.slice(0, maxToolCalls);
      if (calls.length > pick.length) {
        warn(`直连引擎：模型一轮要了 ${calls.length} 个工具，只执行前 ${pick.length} 个`);
      }
      for (const call of pick) {
        stats.toolCalls += 1;
        stats.byTool[call.name] = (stats.byTool[call.name] || 0) + 1;
        const parsed = parseArgs(call.arguments);
        const toolEntry = parsed.ok ? toolbox.find(call.name) : undefined;
        const callArgs = parsed.ok ? injectArgs(toolEntry, parsed.value, extraArgs) : String(call.arguments ?? '');
        // 先记「要调什么」再执行：工具挂住或抛错时，日志里至少留得下这次调用。
        emitToolLog(logHook, {
          type: 'call',
          time: new Date().toISOString(),
          source: 'engine',
          purpose,
          key: logKey,
          tool: call.name,
          args: callArgs,
        });
        let result;
        if (!parsed.ok) {
          result = { ok: false, text: '', error: parsed.error };
        } else {
          const entry = toolEntry;
          const args = callArgs;
          // 主机侧拦截（如直连引擎的「媒体意向」）：返回非空对象即当作这次调用的结果，不真发；
          // 返回 null/undefined 表示不拦。被拦下的调用同样计入 executions/toolCalls，
          // 这样 fallbackSafe 的语义不变（跑过工具就绝不回退 DSH）。
          const intercepted = typeof request.intercept === 'function'
            ? await Promise.resolve()
                .then(() => request.intercept(call.name, args, entry))
                .catch((error) => ({
                  ok: false,
                  text: '',
                  error: `拦截处理失败：${error?.message ?? error}`,
                }))
            : null;
          result = intercepted ?? await toolbox.call(call.name, args);
          stats.executions += 1;
        }
        const outcome = { name: call.name, ok: Boolean(result?.ok), ms: Number(result?.ms) || 0, error: result?.ok ? null : (result?.error ?? null) };
        executed.push(outcome);
        failedStreak = outcome.ok ? 0 : failedStreak + 1;
        emitToolLog(logHook, {
          type: 'result',
          time: new Date().toISOString(),
          source: 'engine',
          purpose,
          key: logKey,
          tool: call.name,
          ok: outcome.ok,
          ms: outcome.ms,
          error: outcome.error,
        });
        const content = result?.ok
          ? (result.text || '（没有返回内容）')
          : `工具执行失败：${result?.error ?? '未知原因'}`;
        const toolMessage = { role: 'tool', tool_call_id: call.id, content };
        messages.push(toolMessage);
        transcript.push({ ...toolMessage });

        // 工具取回来的图片要真给她看。tool 消息只能放文本，所以照 OpenAI 兼容的惯例
        // 紧跟一条 user 多模态消息；顺带嘱咐一句别再调识图工具（她已经能直接看了）。
        const pics = Array.isArray(result?.images) ? result.images : [];
        if (pics.length) {
          const parts = [{ type: 'text', text: `（这是 ${call.name} 取回来的图片，直接看就行，不用再调识图工具。）` }];
          for (const pic of pics) {
            parts.push({ type: 'image_url', image_url: { url: `data:${pic.mimeType};base64,${pic.data}` } });
          }
          messages.push({ role: 'user', content: parts });
          // transcript 只留个记号：别把几百 KB 的 base64 抄进日志。
          transcript.push({ role: 'user', content: `[图片 ×${pics.length}]` });
        }
      }

      // 工具连着坏：再让模型试下去只会把步数烧光，最后一声不吭。
      // 停手跳出去走救援——要一句不用工具的人话。
      if (failedStreak >= failedLimit) {
        warn(`直连引擎：工具连续失败 ${failedStreak} 次，不再重试，改为直接要一句话`);
        break;
      }
    }

    // 步数/额度用尽还没说话。先试一次救援，救回来就照常发言。
    const failedText = summarizeFailures(executed);
    const rescued = executed.length > 0 ? await rescueWithText() : '';
    if (rescued) {
      stats.ok += 1;
      return {
        ok: true,
        text: rescued,
        steps,
        toolCalls: executed,
        usage,
        finishReason,
        fallbackSafe: false,
        rescued: true,
        transcript,
      };
    }

    stats.failed += 1;
    return {
      ok: false,
      // 把「哪个工具在坏」写进 error，下次不用再翻 tool-calls.jsonl 才知道原因。
      error: `达到最大步数（${limit} 步）还没说话${failedText ? `（失败的工具：${failedText}）` : ''}`,
      text: lastText,
      steps,
      toolCalls: executed,
      usage,
      finishReason,
      fallbackSafe: false,
      exhausted: true,
      transcript,
    };
  }

  return {
    version: VERSION,
    run,
    stats: () => ({ ...stats, byTool: { ...stats.byTool } }),
    reset: () => {
      stats.runs = 0;
      stats.ok = 0;
      stats.failed = 0;
      stats.fallbacks = 0;
      stats.steps = 0;
      stats.toolCalls = 0;
      stats.executions = 0;
      stats.byTool = {};
    },
  };
}