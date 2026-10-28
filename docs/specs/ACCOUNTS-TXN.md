# 账号库写事务（`accounts_txn`）

> 状态：现行（2026-10-28）
> 依据：[`crates/buddy-switch-core/src/modules/accounts_txn.rs`](../../crates/buddy-switch-core/src/modules/accounts_txn.rs)

## 1. 这份文档解决的问题

Qoder / Trae 的账号库都是**一个 JSON 文件、整份读、整份写**。每个写函数（续期回写、备注、分组、
签到记录、软删除、导入）都是同一个形态：

```
load 整份  →  改一条  →  save 整份
```

没有互斥时会发生三类事故，且**都不会报错**：

| 事故 | 触发方式 | 症状 |
|:--|:--|:--|
| **丢更新** | 批量续期并发 3 条，或后台保活与手动续期撞车 | 后写者用旧快照整份覆盖，先写者刚落盘的令牌被回滚；两个请求都报成功 |
| **跨进程覆盖** | 桌面端与本地 WebUI 指向同一数据目录，各自 load/save | 同上，但进程内锁完全无效 |
| **损坏库被抹平** | 写路径用**容错读**，库解析失败回落空库后整份写回 | 账号库损坏 → 下一次写操作把剩下账号全部清空 |

第 3 条与并发无关，但同属「整份写」这条路径，所以一并收敛：**写路径的读必须 fail-closed**。

## 2. 三层保护

| 层 | 机制 | 覆盖 |
|:--|:--|:--|
| 进程内互斥 | 按**账号库文件路径**分键的 `std::sync::Mutex` | 同一进程内的所有读改写 |
| 同线程重入 | thread-local 深度计数 | `add_manual` → 写分组 这类嵌套调用（`std::sync::Mutex` 不可重入，直接抢锁会自锁） |
| 跨进程 | 读时记原文，写前重读比对；不一致返回冲突哨兵并**重跑整段** | 两个进程写同一份库 |

锁键用**路径**而不是 `region` / `variant` 枚举，是刻意的：Trae 的国内两条产品线共用一本区域库
（`paths::scoped_file`），按枚举分键会出现「两个调用方各拿一把锁、却写同一个文件」的假互斥；
按路径分键则天然对齐。

跨进程那一层是**乐观**的：比对与 `rename` 之间仍有微秒级窗口，严格互斥需要 OS 文件锁。
本项目不引入平台相关锁的取舍理由写在模块头：账号库写入频率极低（单次几百字节），
乐观重试已把「毫秒级读改写窗口」压到「微秒级比对窗口」。

## 3. 使用纪律（写新代码时照这个来）

1. **任何「读整份 → 改 → 写整份」都必须进 `accounts_txn`**。裸调 `load_*_checked_for` +
   `save_accounts_for` 仍然会丢更新——两个调用之间没有互斥。
2. **闭包里不能写 `return`**。`return` 从**外层函数**返回，会跳过事务收尾（深度计数不归零
   ⇒ 该线程此后同路径写操作全部不加锁，且没有任何报错）。现有实现一律拆成 `*_inner` 函数。
3. **事务内不要 `.await`**。持锁跨 await 会拖住整进程的账号库写操作，且 `std::sync::Mutex`
   跨 await 触发 `Send` 约束。网络请求留在事务外，只有「落盘那一段」进事务。
4. **写路径的读用 `load_*_checked_for`**（失败即 `Err`）。容错读 `load_accounts_for` 只给
   只读展示用：库坏了界面也要能打开，但绝不能拿空库去覆盖。
5. **重试要求修改可重放**：`set_*` / `record_*` 都只做字段级赋值。新增写函数时不要写
   「读出来 +1 再存回去」这类非幂等逻辑（冲突重跑会重复累加）。

## 4. 覆盖范围

已进事务：

- Qoder：`upsert_account_for`、`set_tokens_for`、`set_remark_for`、`set_group_for`、
  `record_checkin_for`、`trash_account_for`、`restore_account_for`
- Trae：`add_manual_for`、`import_local_for`、`trash_for_region`、`restore_for_region`、
  `update_for`、`set_remark_for`、`login_with_exchanged_tokens_for`、
  `apply_refreshed_tokens_for`、`import_accounts_for`
- 续期串行：Qoder `refresh_for`（原有，键 `region:uid`）、Trae `refresh_jwt_for`（2026-10-28 新增，
  键 `variant:uid`）

**刻意未覆盖**（已知残留，改动前先读这一段）：

| 对象 | 现状 | 理由 |
|:--|:--|:--|
| `groups.json`（分组 / 成员关系） | 进程内被账号库事务顺带串行，跨进程无保护 | 不是凭据；丢失后果可修（重新分组），且改动面会扩散到整套分组 API |
| 回收站文件 | 同上 | 软删除的中间态；`qoder::trash` 的写入顺序已保证「两边都有」而不是丢一边 |
| `region_migrate` | 只把目标库的读改成 fail-closed，未包写事务 | 启动期一次性迁移，既有备份；并发窗口可接受 |

## 5. 验证方式

`accounts_txn` 的单元测试里有一条**并发丢更新**用例（8 线程各追加一条，断言 8 条全在）。
它是本次修复的回归护栏，且被验证过「真的会红」：把锁临时短路成 `return f()` 后，
同一用例的失败形态是

```
left: [2]                                  // 只剩最后一个写者的条目
right: [0, 1, 2, 3, 4, 5, 6, 7]
```

这正是线上事故的形态（后写者整份覆盖），不是理论推演。
