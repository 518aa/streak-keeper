# streak-keeper

STREAK 彩票的自动运维机器人，跑在 GitHub Actions 上（无需任何自有服务器）。

## 它做什么

每次 tick（5 分钟）执行三件事：

1. **提前提交种子承诺** —— 为未来 5 轮提交 `keccak256(seed, roundId)`，必须在开票前上链
2. **到点关轮** —— 轮次状态为 `OPEN` 且已过 `closeAt` 时调用 `closeRound()`
3. **揭示种子** —— 状态进入 `CALLING` 后调用 `reveal(roundId, seed)`，合约校验后结算

种子派生规则（无需为每轮保存种子）：

```
seed(roundId)   = keccak256(SECRET, roundId)
commit(roundId) = keccak256(seed, roundId)
```

`SECRET` 只存在 Actions Secret `SEED_SECRET` 里，代码与日志中都不出现。

## 运行方式

GitHub 对 `schedule` 有严重降频（实测 6–8 小时才触发一次），因此采用**自我续跑**：

- 每次运行在 job 内循环 5 小时 20 分，每 5 分钟 tick 一次
- 结束前用内置 `GITHUB_TOKEN` 主动 `workflow_dispatch` 下一次运行
- `concurrency` 组保证同一时刻只有一个 keeper 在跑
- `schedule`（每 6 小时）仅作为链条断裂时的保险

## 配置

| 类型 | 名称 | 说明 |
|---|---|---|
| Secret | `KEEPER_PK` | keeper 钱包私钥 |
| Secret | `SEED_SECRET` | 种子派生密钥（32 字节 hex） |
| Secret | `TG_TOKEN` | 战报机器人 token（`report` 用） |
| Secret | `TG_CHAT` | 战报目标群 chat id |
| Variable | `LOTTERY_ADDRESS` | 彩票合约地址 |
| Variable | `PROVIDER_ADDRESS` | 随机源 provider 地址 |
| Variable | `RPC_URL` | BSC RPC |
| Variable | `SITE_URL` | 官网地址（战报里引用） |

## 其他 workflow

- `report.yml` —— 轮次结算后把战报发到 Telegram
- `tg-id.yml` —— 临时工具：查群 chat id
- `tg-test.yml` —— 一次性测试消息

## 说明

仓库公开仅为获得不限量的 Actions 分钟数（私有仓库 2000 分钟/月不够长任务使用）。
本仓库不含任何私钥，所有敏感值都在 Actions Secrets 中。
