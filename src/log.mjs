// 日志：只记录"请求形状 + 签名长度"，绝不落 Cookie / 签名值。

const SECRET_HEADERS = /^(cookie|authorization|set-cookie|x-helios|x-medusa|x-ss-stub)$/i

export function redactHeaders(headers = {}) {
    const result = {}
    for (const [name, value] of Object.entries(headers)) {
        result[name] = SECRET_HEADERS.test(name) ? `<redacted ${String(value).length} chars>` : String(value)
    }
    return result
}

export function logEvent(event, detail = {}) {
    const line = { at: new Date().toISOString(), event, ...detail }
    process.stdout.write(`${JSON.stringify(line)}\n`)
}

export function logError(message) {
    const line = { at: new Date().toISOString(), event: 'error', message: String(message) }
    process.stderr.write(`${JSON.stringify(line)}\n`)
}
