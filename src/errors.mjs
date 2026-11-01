// 错误分类：按「调用方下一步做什么」切开失败，而不是按内部异常命名。
//
// 只有两类失败是「等一会儿会好」——被限流、服务忙；其余都必须有人改请求或改机器，
// 所以只有它们带等待时长。502（网关从上游收到无效响应）不在分类表里：本进程不是网关。
// #9 起这张表只服务 /sign（src/dispatcher.mjs）：诊断端点已从 HTTP 收掉，`src` 下不再有
// 任何一个发 502 的出口。
//
// 时间不做成接缝：需要的地方把当前时刻当参数传进来，定时器只负责用当前时间去调；
// 本模块自己不读墙上时钟，所以同一组入参永远算出同一个秒数。

/** 原因码是稳定字符串：同一个失败永远是同一个码；动态信息放平级扩展字段。 */
export const ERROR_KINDS = {
    SUCCESS: 'SUCCESS',
    INVALID_REQUEST: 'INVALID_REQUEST',
    UNAUTHORIZED: 'UNAUTHORIZED',
    RATE_LIMITED: 'RATE_LIMITED',
    BUSY: 'BUSY',
    SIGNER_UNAVAILABLE: 'SIGNER_UNAVAILABLE',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
}

/** 服务忙固定等多久（秒）：槽位自己会腾出来，不需要调用方算。 */
export const BUSY_RETRY_AFTER_SECONDS = 1

/** 本票规定的最小值：时刻正好、甚至已经过期，都不能回 0 秒。 */
const MIN_RETRY_AFTER_SECONDS = 1

const WAIT_NONE = 'none'
const WAIT_FIXED = 'fixed'
/** 等待时长由限流器算出的精确时刻决定。 */
const WAIT_FROM_CALLER = 'caller'

const TABLE = {
    [ERROR_KINDS.SUCCESS]: { status: 200, code: null, wait: WAIT_NONE },
    [ERROR_KINDS.INVALID_REQUEST]: { status: 400, code: ERROR_KINDS.INVALID_REQUEST, wait: WAIT_NONE },
    [ERROR_KINDS.UNAUTHORIZED]: { status: 401, code: ERROR_KINDS.UNAUTHORIZED, wait: WAIT_NONE },
    [ERROR_KINDS.RATE_LIMITED]: { status: 429, code: ERROR_KINDS.RATE_LIMITED, wait: WAIT_FROM_CALLER },
    [ERROR_KINDS.BUSY]: { status: 503, code: ERROR_KINDS.BUSY, wait: WAIT_FIXED },
    [ERROR_KINDS.SIGNER_UNAVAILABLE]: { status: 500, code: ERROR_KINDS.SIGNER_UNAVAILABLE, wait: WAIT_NONE },
    [ERROR_KINDS.INTERNAL_ERROR]: { status: 500, code: ERROR_KINDS.INTERNAL_ERROR, wait: WAIT_NONE },
}

/** 认不出来的原因一律按「必须有人来修」处理：不催调用方重试，也不冒充成能重试。 */
const UNKNOWN = TABLE[ERROR_KINDS.INTERNAL_ERROR]

/**
 * 下次可请求的精确时刻 → 整数秒：向上取整、最少 1 秒。
 *
 * 限流器拒绝时天然知道这个时刻，正好就是 `Retry-After` 要的数。两个时刻都只从参数来；
 * 缺任何一个都退到最小 1 秒——宁可让调用方多等一秒，也不回一个不带 `Retry-After` 的 429。
 */
export function retryAfterFromInstant(retryAtMs, nowMs) {
    const waitMs = Number(retryAtMs) - Number(nowMs)
    if (!Number.isFinite(waitMs)) return MIN_RETRY_AFTER_SECONDS
    return Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(waitMs / 1000))
}

/** 分类一种情况：状态码、稳定原因码、以及有没有等待时长。成功那一行也在这张表里。 */
export function classify(kind, { retryAtMs, nowMs } = {}) {
    // 必须挡掉原型链上的键：'constructor' / '__proto__' 也是字符串，
    // 而 TABLE[kind] 会拿到一个真值，把上面的默认落点绕过去。
    const entry = Object.hasOwn(TABLE, kind) ? TABLE[kind] : UNKNOWN
    let retryAfterSeconds = null
    if (entry.wait === WAIT_FIXED) retryAfterSeconds = BUSY_RETRY_AFTER_SECONDS
    else if (entry.wait === WAIT_FROM_CALLER) retryAfterSeconds = retryAfterFromInstant(retryAtMs, nowMs)
    return { status: entry.status, code: entry.code, retryAfterSeconds }
}

/** 429 的提示语只有一句：#9 之后 HTTP 上只剩 `/sign` 会被限流，将来再有计算入口也复用这句。 */
export const RATE_LIMITED_MESSAGE = '请求过于频繁：这个地址的额度已用完'

/**
 * 429 的统一回包：等待时长由限流器给出的精确时刻算，头和体由 failureResponse 保证是同一个整数。
 */
export function rateLimitedResponse({ retryAtMs, nowMs } = {}) {
    return failureResponse(ERROR_KINDS.RATE_LIMITED, { message: RATE_LIMITED_MESSAGE, retryAtMs, nowMs })
}

/**
 * 一次失败的回包：状态码、响应头、响应体。
 *
 * 等待时长在头和体各写一份：头是中间件唯一能读到的地方，体是头支持不一致时的兜底，
 * 两处必须是同一个整数。响应自己的框架（Content-Type / Content-Length）仍归写出路径。
 *
 * `details` 是平级扩展字段（哪个参数错了之类），客户端可以忽略不认识的东西。
 */
export function failureResponse(kind, { message, details, retryAtMs, nowMs } = {}) {
    // 成功不是失败：拿 SUCCESS 来要失败回包说明接线接错了。按默认落点走 500 INTERNAL_ERROR，
    // 绝不能回一个不带签名的 200——客户端会把 200 当成可用签名继续发，症状是静默降级成试听片段。
    const { status, code, retryAfterSeconds } = classify(
        kind === ERROR_KINDS.SUCCESS ? ERROR_KINDS.INTERNAL_ERROR : kind,
        { retryAtMs, nowMs },
    )
    const headers = {}
    const body = { ...details, ok: false, error: message, code }
    // 扩展字段不许夹带等待时长：头和体只由这一次分类说了算，否则「其余不带」会被绕过。
    delete body.retry_after_seconds
    if (retryAfterSeconds !== null) {
        headers['Retry-After'] = String(retryAfterSeconds)
        body.retry_after_seconds = retryAfterSeconds
    }
    return { status, headers, body }
}
