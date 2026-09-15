/**
 * crash-guard.js —— ★★★ **保命网**：给本进程的 `stdout`/`stderr` 装 `'error'` 监听，
 *   只吞**管道断开**那一族（`EOF` / `EPIPE`）；**别的 error 照旧抛**。
 *
 * ## 现场（逐字，取自 `D:\dsh\desktop\web.log`，2026-09-15）
 * ```
 * node:events:497  throw er; // Unhandled 'error' event
 * Error: write EOF
 *     at WriteWrap.onWriteComplete (node:internal/stream_base_commons:87:19)
 * Emitted 'error' event on Socket instance at: emitErrorNT (node:internal/streams/destroy:170:8)
 * errno: -4095, code: 'EOF', syscall: 'write'
 * ⇒ dsh exited code=1 signal=null   ⇒ service died, restarting in 800ms (第 1/5 次)
 * ```
 * ★ **5 起**：`09-12 07:09:42` · `09-12 10:39:32` · `09-14 11:37:48` · `09-15 12:42:55` · `09-15 12:45:39`
 *   ⇒ ★★ `teamkit` 在该日志里**最早出现于 `09-14 06:37:56`** ⇒ **09-12 那两起不是我们**
 *     （`R5`：**能解释全部 5 起的才是真因**）
 *
 * ## 根因链（CEO 逐行核过；我独立复核源码）
 * ```
 * 【第 1 环】桌面壳 `D:\dsh\desktop\main.js:169`
 *     `child = spawn(DSH_NODE, [DSH_CLI, ...cliArgs], { env, windowsHide: true, cwd })`
 *   ⇒ ★ **没给 `stdio` ⇒ Node 默认 `'pipe'`** ⇒ `child.stdout` / `child.stderr` 是 **net.Socket**
 *     `:177 child.stdout.on('data', onData)` · `:178 child.stderr.on('data', …)` ⇒ **壳在读**
 * 【第 2 环】★★★ **壳自己知道这个坑，并给自己装了防护 —— 但那只保护【壳】**
 *     `:14 // 防 EPIPE：主进程的 stdout/stderr 管道可能被外部关闭…任何 console 输出都会变成未捕获异常。`
 *     `:17 for (const s of [process.stdout, process.stderr]) s.on('error', () => {})`
 *   ⇒ ★★ **壳保护了自己，却没保护它 spawn 的 dsh 子进程**
 * 【第 3 环】管道被关 ⇒ 子进程 write ⇒ **未捕获 `'error'`** ⇒ **进程自杀 `code=1`**
 * ```
 * ⇒ ★★★ **一句话**：**dsh 子进程的 stdout/stderr 是 pipe；管道被关后任何 write 抛未捕获 EOF ⇒ 自杀。**
 *
 * ## 本网做什么（**范围最小，边界可证**）
 * ```
 * · **只**给 `process.stdout` / `process.stderr` 装 `'error'` 监听 ——
 *   ★ **这是把桌面壳 `main.js:17` 对它自己做过的事，应用到子进程侧**（同一个已知补救）
 * · ★★ **只吞管道类**：`code === 'EOF'` / `'EPIPE'`（或 `errno === -4095` 且栈含 `Socket`/`WriteWrap`）
 *   ⇒ ⚠️ **别的 error 一律重新抛**（→ 未捕获 → 走 Node 默认行为 → 崩）⇒ **不掩盖任何别的错误**
 * · ⛔ **不装 `process.on('uncaughtException')`** —— 那会吞掉**所有**异常（含我们自己的 bug）
 *   （★ 我第一版写过它，**已按 CEO §④③ 的硬边界撤掉** —— 那条边界是对的）
 * · ★ **可卸净**：`dispose()` 移除监听 ⇒ `listenerCount('error')` 回到原值（`R22`）
 * ```
 *
 * ## 能红证据（`tools/crash-guard-test.mjs` ⇒ **PASS 12/12**，四条判据全双向）
 * ```
 * ① 装网 + 管道断 ⇒ **不死**（exit 0） · **不装网** ⇒ **照旧崩**（`Emitted error event on Socket instance`）
 * ② ★ 装网 + 普通 `TypeError` ⇒ **照旧崩** ← **这条才是"没有掩盖错误"**
 * ③ 监听器计数：装前 **0** / 装后 **1** / 卸后 **0**
 * ④ 非管道类 error（伪造 `code:'EBADF'`）⇒ **照旧抛**（不是"什么都吞"）
 * ⑤ 装上后 `console.log` **仍照常出去**（不许静默）
 * ```
 *
 * ⚠️ **诚实边界**：我的复现产出的是 **`EPIPE: broken pipe, write`**，而现场是 **`write EOF`** ——
 *   两者是**同一族**（往已断的管道写），Node 在不同时机给不同 errno ⇒ 判据按**族**判。
 */

/** ★ 只认"管道断开"这一族 —— **窄到不能再窄** */
export const isPipeBroken = (err) => {
  if (err === null || typeof err !== 'object') return false
  const code = err.code
  const errno = err.errno
  // ★ 主判据：code 必须是 EOF / EPIPE
  if (code === 'EOF' || code === 'EPIPE') return true
  // ★ 次判据：`errno === -4095`（EOF 的 Windows 值）+ 栈/消息里能看出是 socket 写
  if (errno === -4095) {
    const stack = typeof err.stack === 'string' ? err.stack : ''
    const msg = typeof err.message === 'string' ? err.message : ''
    return /\bSocket\b|WriteWrap/.test(stack) || /write EOF|EPIPE/.test(msg)
  }
  return false
}

/**
 * 装上保命网（**只装 stdout/stderr 的 `'error'` 监听**）。
 * @param {{log?: (m: string) => void}} [opts]
 * @returns {{dispose: () => void, stats: () => object}}
 */
export const installCrashGuard = ({ log = () => {} } = {}) => {
  const stats = { caught: 0, rethrown: 0, details: [] }
  const streams = [process.stdout, process.stderr]
  const before = streams.map((s) => s.listenerCount('error'))

  const makeHandler = (name) => (err) => {
    if (isPipeBroken(err)) {
      stats.caught += 1
      stats.details.push({
        at: new Date().toISOString(),
        stream: name,
        code: err?.code,
        errno: err?.errno,
        message: String(err?.message ?? '').slice(0, 80),
      })
      log(`吞掉 ${name} 的管道断开：code=${err?.code} errno=${err?.errno}（宿主本该继续跑）`)
      return // ★ **不抛 ⇒ 不自杀**
    }
    stats.rethrown += 1
    // ★★ **别的 error ⇒ 重新抛**（→ 未捕获 → Node 默认行为 ⇒ 崩）
    throw err
  }

  const handlers = streams.map((s, i) => {
    const h = makeHandler(i === 0 ? 'stdout' : 'stderr')
    s.on('error', h)
    return { s, h }
  })

  return {
    dispose: () => {
      for (const { s, h } of handlers) s.removeListener('error', h)
    },
    stats: () => ({ ...stats, before, after: streams.map((s) => s.listenerCount('error')) }),
  }
}
