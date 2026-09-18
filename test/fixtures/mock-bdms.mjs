// 假的 bdms.node：在 Linux/CI 上跑测试用。
// 它的输出是确定性的，方便断言"签名确实覆盖了 URL + 请求头"。

let currentDeviceId = ''

export function init({ deviceId } = {}) {
    currentDeviceId = String(deviceId || '')
}

export function generateHttpSignatureHeaders(url, headerLines) {
    const digest = (value) => {
        // 不用 crypto，纯字符串散列即可（测试只需要"输入不同 → 输出不同"）
        let hash = 2166136261
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index)
            hash = Math.imul(hash, 16777619)
        }
        return (hash >>> 0).toString(36)
    }
    const helios = `mock-helios-${digest(`${currentDeviceId}|${url}`)}`
    const medusa = `mock-medusa-${digest(`${url}|${headerLines}|${currentDeviceId}`)}`
    return [`X-Helios`, helios, `X-Medusa`, medusa].join('\r\n')
}

export function report() {}
