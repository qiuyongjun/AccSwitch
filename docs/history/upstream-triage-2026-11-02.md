# 上游 254 提交的分流结论（2026-11-02）

> 状态：只读历史（不再更新）。一次性分流报告，结论已落为 `merge/upstream-triage` 分支上的 18 个提交。

## 一句话结论

**本地 `main` 没有 `dev` 缺的东西**（`main` 正落在分叉点上，`git rev-list --left-right --count main...dev` = `0 13`）。
真正要评估的是 `origin/main` 上 254 个提交：其中 **17 个**属于「dev 侧同样需要、且能独立成立」的修复，
其余按「需手工移植」与「明确不取」分流。

## 分支事实

| 项 | 值 |
|:--|:--|
| 真正的分叉点 | `afa0b70`（`git merge-base origin/main dev`） |
| `dev` 自有提交 | 11（另含 2 个此前已手工移植的上游提交：`66a33ab`、`afa0b70`） |
| 上游新增提交 | 254（不含 merge） |
| 双方都改过的文件 | 104 |
| 上游提交中「零冲突可应用」的 | 54 |

## 为什么不做 `git merge origin/main`

`dev` 与上游是两条**产品线**，不是补丁分歧：`dev` 做了品牌更名（AccSwitch）、三平台账号页对齐、
概览页移除、成长任务中心；上游独立做了密钥权限与配额（#76）、模型降级链（P13 / #129）、聚合页（#50）、
用量页账本化（#63）、账号池排除、CodeBuddy CLI 接入（#109）。直接合并会把两套实现堆在同一棵树里，
冲突只是表象，语义重复才是主要成本。

## 已挑取：17 个修复 + 1 个适配

| 主题 | 提交 |
|:--|:--|
| Trae 凭据与 JWT | `74b70a2`（refresh_token 绑签发它的 ClientID）、`2119bea`（区分 storage.json 缺失与读不出） |
| Qoder 保活与钥匙串 | `a122eed`（保活窗口 4h→48h）、`1635f0a`（macOS 按区域取服务名）、`ca30d24`（枚举兜底） |
| 安全 | `d2a5b41`（OAuth 主机白名单 / CSRF fail-closed / helper 执行白名单）、`eb30fda`（管理面 Host-Origin 校验、凭据落盘 0600） |
| 账号池「已排除」 | `69e8b87`、`743174a`、`3f254b3`（含门禁断言） |
| 设置死锁 | `9a2a0a9`（作用域开关方向敏感禁用） |
| 门禁与 CI | `94b55b9`（Windows 编译覆盖 / 串行测试 / 程序位双向）、`8274699`、`9085caa`、`2dc1076`、`3ee48b4`、`321ae85` |
| 适配 | `4a836d3`（删掉 `qoder_gateway_quota` 的 `SCOPE_PARAMETERIZED` 登记 —— 本分支无该命令） |

`9085caa` 把「先剥行注释再剥块注释」的修复与一条登记项打包在同一提交里，登记项指向上游 #88 的额度视图命令，
`dev` 侧不存在 ⇒ 单独一个适配提交只删登记，保留修复本体。

## 未挑取

**① 缺前置、机械挑会编不过**（`git` 能打上，语义不成立，已实测红）：

| 提交 | 缺的前置 |
|:--|:--|
| `d04c1ab` 顺序档粘住账号 | `4f13e80` 顺序选号档 |
| `f732860` `default_namespace` 生效 | #76 密钥配额链（`QuotaMode` 等类型） |
| `d8c45f6` `qoder_gateway_quota` 插入位置 | Qoder 网关配额功能 |
| `d4db10a` 环形图半径按容器推导 | 与 `dev` 重构后的 `model-donut.tsx` 重复声明变量 |

**② 值得手工移植，按优先级**

1. 网关冷却与状态码语义：`ce39776` / `0ea3be2` / `611f890` / `43e6926` / `cd4b8d7` / `fd8d94f`
   —— 上游把「账号冷却」从 401 改判 503，并让兜底选号看见模型级冷却；`dev` 仍是旧语义，客户端会误判成 Key 错。
2. 模型降级链 / 自动切换（P13、#129）：约 10 个提交，**必须成组移植**，不能拆。
3. Qoder/Trae 稳定性单点：`d4e3d74`（单条脏数据打挂整区）、`31554c0` / `7736ce0`（排队伪装成凭据失效）、
   `1141f25`（responses usage 恒 0%）、`dfa74d0`（并行工具调用被拆散）、`9d54fab`（apply_patch 被静默丢弃）。
4. 前端 bug：`b5cad64`（用量页「今天」白屏，React #300）、`dfe1b24`（asChild 把 className 串成字符串）、
   `d5f4229`（菜单每项都弹抽屉）。
5. 密钥权限与配额（#76）：仅当网关要做公共 API 时才有意义。

**③ 明确不取**

- 品牌相关全部（README 语种、图标、打赏、免责声明、首启同意）—— `dev` 已更名 AccSwitch，合入等于回退。
- `docs/prototype/` 整块与生成脚本 —— `scripts/check-scope-registry.cjs` 直读该目录，上游同时改了脚本与产物。
- `docs/releases/*` + `src/data/release-notes.json` + `chore(release)` 版本号 —— 那是上游的版本线。
- 13 个全量 `style(rust)` 格式化提交 —— 会造成上万行无关 diff。
- 聚合页（#50）与用量页账本化（#63）—— `dev` 已把统计收进单一 `UsagePage`，两套 UI 会打架。

## 验证证据

分支 `merge/upstream-triage`（`dev` + 18），逐提交累积校验：

| 检查 | 结果 |
|:--|:--|
| `cargo check --workspace --all-targets` | 0 error |
| `npx tsc --noEmit` | 0 error |
| `npm run build`（含 8 个门禁脚本） | 通过，`check:scope` 312 项 |
| `cargo test -p buddy-switch-core` | 1557 lib + 29 集成，0 failed |

未跑 `cargo test --workspace`：`src-tauri` 的测试二进制链接失败（`LNK1104`），原因是本机有正在运行的
`buddy-switch-rust` 实例占用同名 exe，属环境占用而非代码问题；`src-tauri` 侧已由 `cargo check --all-targets` 覆盖。
