// 日志：只记录"请求形状 + 签名长度"，绝不落 Cookie / 签名值。

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SECRET_HEADERS = /^(cookie|authorization|set-cookie|x-helios|x-medusa|x-ss-stub)$/i

/** 本模块自己的项目根：与 config.mjs / identity.mjs 同一算法，这里再算一份是为了不绕进循环引用。 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function redactHeaders(headers = {}) {
    const result = {}
    for (const [name, value] of Object.entries(headers)) {
        result[name] = SECRET_HEADERS.test(name) ? `<redacted ${String(value).length} chars>` : String(value)
    }
    return result
}

/**
 * 这台机器上会出现在报错原文里的路径候选。
 *
 * require() 失败会带上模块绝对路径、它所在的目录，有时还有 cwd 与 home 短形。
 * 短于 3 个字符的一律不收：`path.dirname('')` 是 '.'，收进来会把「bdms.node」吃成
 * 「bdms(本机路径)node」—— 脱敏脱错了比不脱更糟。
 */
function sensitivePaths(extra = []) {
    return [...extra, process.cwd(), os.homedir(), PROJECT_ROOT].filter(
        location => typeof location === 'string' && location.length >= 3,
    )
}

/**
 * 抹掉文本里的本机路径。
 *
 * 约定里日志只允许请求形状、签名长度和脱敏设备号，而这条路径属于部署者的机器；公开仓库也
 * 不该出现它。精确匹配替换（不区分大小写会误伤正文），没匹配到就原样返回。
 */
export function redactMachinePaths(text, locations = []) {
    let redacted = String(text ?? '')
    for (const location of sensitivePaths(locations)) {
        redacted = redacted.split(location).join('(本机路径)')
    }
    return redacted
}

/**
 * 对对象里的每个字符串跑一次 redactMachinePaths，供命令行输出（selftest / config）使用。
 *
 * 为什么不在 JSON.stringify 之后做：Windows 路径在 JSON 文本里是 `C:\\Users\\…`，
 * 拿原始路径去 split 对不上，结果会把整条原文原样留下。
 */
export function redactMachinePathsDeep(value, locations = []) {
    if (typeof value === 'string') return redactMachinePaths(value, locations)
    if (Array.isArray(value)) return value.map(item => redactMachinePathsDeep(item, locations))
    if (value && typeof value === 'object') {
        const result = {}
        for (const [key, item] of Object.entries(value)) result[key] = redactMachinePathsDeep(item, locations)
        return result
    }
    return value
}

export function logEvent(event, detail = {}) {
    const line = { at: new Date().toISOString(), event, ...detail }
    process.stdout.write(`${JSON.stringify(line)}\n`)
}

/**
 * 告警走 stderr，不进 stdout：`bridge` / `selftest` / `config` 用 stdout 吐机器可读结果
 * （libresoda 按次拉起 `bridge` 并 JSON.parse 那一个对象），降级告警一旦混进去就会让调用方
 * 要么解析失败、要么拿到一个没有 X-Helios 的对象。`serve` 模式 stdout/stderr 都会被容器日志收走。
 */
export function logWarn(event, detail = {}) {
    const line = { at: new Date().toISOString(), event, level: 'warn', ...detail }
    process.stderr.write(`${JSON.stringify(line)}\n`)
}

export function logError(message) {
    const line = { at: new Date().toISOString(), event: 'error', message: String(message) }
    process.stderr.write(`${JSON.stringify(line)}\n`)
}
