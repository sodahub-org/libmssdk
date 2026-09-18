// 契约校验：与 libresoda 的 SignRequest / SignResponse 对齐，也和 Meting-API
// 的扁平回包兼容（{"ok":true,"X-Helios":"…","X-Medusa":"…"}）。

const asText = value => (value === undefined || value === null ? '' : String(value))

/**
 * 归一化调用方传来的签名请求。
 *
 * 必填：url
 * 选填：method（默认 POST）、body、headers、ts_ms、device_id
 */
export function normalizeSignRequest(input) {
    const payload = input && typeof input === 'object' ? input : {}
    const url = asText(payload.url).trim()
    if (!url) throw new ValidationError('url 不能为空')
    if (!/^https?:\/\//i.test(url)) throw new ValidationError('url 必须是 http(s) 绝对地址')

    const headers = {}
    for (const [name, value] of Object.entries(payload.headers || {})) {
        if (!name) continue
        if (value === undefined || value === null) continue
        if (typeof value === 'object') throw new ValidationError(`请求头 ${name} 必须是字符串`)
        headers[name] = String(value)
    }

    return {
        url,
        method: (asText(payload.method).trim() || 'POST').toUpperCase(),
        body: asText(payload.body),
        headers,
        ts_ms: Number(payload.ts_ms) || Date.now(),
        deviceId: asText(payload.device_id || payload.deviceId).trim(),
    }
}

/** 统一的回包形状。 */
export function signResponse({ headers, deviceId, elapsedMs }) {
    const normalized = {}
    for (const [name, value] of Object.entries(headers || {})) {
        // 统一成官方写法，libresoda 侧按大小写不敏感合并，这里只保留 X-Helios / X-Medusa
        const lower = name.toLowerCase()
        if (lower === 'x-helios') normalized['X-Helios'] = value
        else if (lower === 'x-medusa') normalized['X-Medusa'] = value
        else normalized[name] = value
    }
    return {
        ok: true,
        headers: normalized,
        device_id: deviceId || undefined,
        elapsed_ms: elapsedMs,
    }
}

export function errorResponse(message, code = 'signer_error') {
    return { ok: false, error: message, code }
}

export class ValidationError extends Error {
    constructor(message) {
        super(message)
        this.name = 'ValidationError'
        this.code = 'invalid_request'
    }
}
