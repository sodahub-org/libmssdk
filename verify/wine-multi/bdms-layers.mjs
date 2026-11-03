// 分层探针：把「加载原生模块 / init / 签名」三层各自出声，用来定位卡在哪一层。
//
// 为什么要有它：从 `/mnt/*` 这类 drvfs 绑定挂载里加载 bdms.node 时，Wine 会挂在 DllMain 里
// 不返回——进程安静、没有报错，看不出卡在哪一步（#30）。每层**进之前**先打一行，所以
// 「最后一条 step」本身就是答案：停在 load 就是加载，停在 init 就是 init，一条都不打才是别处。
//
// 整个文件只 import Node 内置模块，为的是「一个 `docker cp` 就能带进容器」——它要诊断的正是
// 容器里那条路，带上仓库内的相对 import 就没法单独拷进去。
//
// 不打上游、不碰 cookie：签名要的 url 与头都是当场编的。
//
//   node verify/wine-multi/bdms-layers.mjs <bdms.node 路径>
//   docker cp verify/wine-multi/bdms-layers.mjs <容器>:/tmp/
//   docker exec -t <容器> wine /opt/node-win/node.exe /tmp/bdms-layers.mjs <容器内的 bdms.node 路径>
//
// 容器里唯一别做的事：把它的 stdout 接管道——Wine 下的 Node 打不开管道型 stdio，当场
// `open EBADF`（容器内 bash 自己 `| grep` 也一样）。TTY 直接看、或者重定向到文件再 `cat`，都可以。
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const write = text => process.stdout.write(`step=${text}\n`)
// 失败只报「哪一层 + 类别」，不复述 `err.message`、也不回声传进来的路径：原生模块加载失败时
// 原文里一定带着本机绝对路径，而这份输出是给人直接贴进票里的（约定 7 与开源边界）。
const fail = reason => {
    write(`failed ${reason}`)
    return 1
}

function layers(modulePath, deviceId) {
    write(`begin device=${String(deviceId).length}位`)
    if (!modulePath) return fail('layer=args reason=missing 把 bdms.node 的路径作为第一个参数传进来')
    if (!fs.existsSync(modulePath)) return fail('layer=load reason=missing 这个路径上没有文件')

    write('load')
    const module = require(modulePath)
    const hasInit = typeof module?.init === 'function'
    const hasSign = typeof module?.generateHttpSignatureHeaders === 'function'
    // 判据与 src/bdms.mjs 的 load() 同形（init / generateHttpSignatureHeaders 两个都要在）。
    // 不 import 它，是为了这个文件能单独拷进容器——改那边的导出判据时记得回来看这条。
    if (!hasInit || !hasSign) return fail(`layer=load reason=exports hasInit=${hasInit} hasSign=${hasSign}`)
    write('loaded')

    write('init')
    module.init({ deviceId })
    write('inited')

    write('sign')
    // 直接调原生函数，不走服务侧的 sign()：那边会校验 X-Helios 与 X-Medusa 都在，而探针给的
    // 是一份最小编出来的头，官方模块在这种输入下常只回一头——那是探针的输入形状，不是缺陷。
    // 本层只问一句：这一层调用返不返回、返回几行。
    const raw = module.generateHttpSignatureHeaders(`https://api.qishui.com/luna/pc/me?device_id=${deviceId}`, 'accept\r\napplication/json\r\n')
    write(`signed lines=${String(raw || '').split('\r\n').filter(Boolean).length}`)
    write('done')
    return 0
}

try {
    process.exitCode = layers(process.argv[2], process.argv[3] || String(Date.now()))
} catch (error) {
    // 抛出来的，不是挂住的；卡在哪一层看上一条 step。原文里全是路径，所以只报错误类别。
    process.exitCode = fail(`reason=threw name=${error?.name || 'Error'}`)
}
