// bdms.node 的加载与调用：把官方客户端的应用签名能力封成一个小 API。
//
// 为什么是它：汽水每个发往 api.qishui.com 的请求都会带上
// `X-Helios` / `X-Medusa`，这两个头由客户端里的原生模块生成。sourcemap 泄漏的
// `src/app.ts` 显示官方用法就是：
//
//   bdms.init({ deviceId })
//   const pairs = bdms.generateHttpSignatureHeaders(url, headersLines).split('\r\n')
//   // 按 name/value 成对写回请求头
//
// 所以这里不逆向 DLL，只复用客户端自带的模块。

import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 把 headers 转成官方约定的 "名字\r\n值\r\n名字\r\n值…" 形式。 */
export function flattenHeaders(headers = {}) {
    const lines = []
    for (const [name, value] of Object.entries(headers)) {
        if (!name) continue
        if (value === undefined || value === null) continue
        lines.push(`${name}\r\n${value}`)
    }
    return lines.join('\r\n')
}

/** 解析官方返回值（成对的 name/value）成对象。 */
export function parseSignaturePairs(raw) {
    const fields = String(raw || '')
        .split('\r\n')
        .filter(item => item.trim())
    const headers = {}
    for (let index = 0; index + 1 < fields.length; index += 2) {
        headers[fields[index]] = fields[index + 1]
    }
    return headers
}

export class BdmsSigner {
    #module = null
    #bdms = null
    #deviceId = ''

    constructor({ modulePath, deviceId = '' } = {}) {
        this.modulePath = modulePath || ''
        this.defaultDeviceId = deviceId || ''
    }

    get deviceId() {
        return this.#deviceId || this.defaultDeviceId
    }

    get available() {
        return Boolean(this.modulePath) && fs.existsSync(this.modulePath)
    }

    /** 加载原生模块（首次调用时才 require，避免无客户端环境下直接崩）。 */
    load() {
        if (!this.modulePath) {
            throw new Error('未找到 bdms.node：请设置 LIBMSSDK_CLIENT_DIR 或 LIBMSSDK_BDMS_MODULE')
        }
        if (!fs.existsSync(this.modulePath)) {
            throw new Error(`bdms.node 不存在：${this.modulePath}`)
        }
        if (!this.#bdms) {
            this.#module = require(this.modulePath)
            if (typeof this.#module?.init !== 'function' || typeof this.#module?.generateHttpSignatureHeaders !== 'function') {
                throw new Error('bdms.node 导出不符合预期（需要 init / generateHttpSignatureHeaders）')
            }
            this.#bdms = this.#module
        }
        return this.#bdms
    }

    /** 设备号变了要重新 init（官方就是一次 init 绑定一个 did）。 */
    ensureInit(deviceId) {
        const bdms = this.load()
        const target = String(deviceId || this.defaultDeviceId || '').trim()
        if (!target) throw new Error('缺少 device_id：请在 URL / headers 里带上，或设置 LIBMSSDK_DEVICE_ID')
        if (this.#deviceId === target) return bdms
        bdms.init({ deviceId: target })
        this.#deviceId = target
        return bdms
    }

    /**
     * 给一次请求签名。
     *
     * 注意：签名覆盖 **URL + 全部请求头**，所以 `headers` 必须是"真实要发出去的那一份"
     * （尤其 `cookie` 与 `x-ss-stub` = body 的 MD5 大写）。
     */
    sign({ url, headers = {}, deviceId = '' } = {}) {
        if (!url) throw new Error('url 不能为空')
        const target = deviceId || deviceIdFrom(url, headers) || this.defaultDeviceId
        const bdms = this.ensureInit(target)
        const raw = bdms.generateHttpSignatureHeaders(String(url), flattenHeaders(headers))
        const signed = parseSignaturePairs(raw)
        const names = Object.keys(signed)
        if (!names.some(name => name.toLowerCase() === 'x-helios') || !names.some(name => name.toLowerCase() === 'x-medusa')) {
            throw new Error(`签名不完整：只拿到 ${names.length} 个头（${names.join(',') || '空'}）`)
        }
        return { deviceId: target, headers: signed }
    }
}

export function deviceIdFrom(url, headers = {}) {
    const direct = headers.device_id || headers['device-id'] || headers['Device-Id']
    if (direct) return String(direct).trim()
    try {
        const parsed = new URL(String(url))
        for (const key of ['device_id', 'fp', 'did']) {
            const value = parsed.searchParams.get(key)
            if (value) return value.trim()
        }
    } catch {
        /* URL 不合法就忽略 */
    }
    return ''
}
