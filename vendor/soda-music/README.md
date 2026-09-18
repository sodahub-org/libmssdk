# 用户提供的官方签名模块

这个目录用于存放你**自己安装的**汽水音乐客户端中的两个文件：

| 文件 | 作用 |
| --- | --- |
| `bdms.node` | 由 Windows / Electron 版 Node 加载，生成应用签名头 |
| `metasecml.dll` | `bdms.node` 依赖的库；必须与它同目录 |

这些文件**不在本仓库中，也不得提交或再分发**。它们是官方客户端二进制，不属于本仓库
MIT 源码授权范围。

版本行为与客户端版本相关。更换文件后，运行 `node src/index.mjs selftest`，并用
`node src/index.mjs probe --track <track_id> --cookie "<your cookie>"` 确认服务端接受签名。
