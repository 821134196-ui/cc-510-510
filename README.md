# 颐年呼叫联动系统(养老机构)

把床位、呼叫按钮、当班护理员和夜巡计划关联起来的呼叫联动系统。零第三方依赖(Node ≥ 22.5,使用内置 `node:sqlite` / `node:test`),SQLite 保存事件,交接附件存本地文件,按钮与通知均为模拟适配器。

> 演示环境:所有住户姓名、病情、联系方式均为**虚构样本**。

## 一条命令启动

```bash
node run.js --demo      # 启动并生成演示案例(按钮离线 + 超时未响应 + 连续呼叫 + 外出触发 + 夜巡漏检)
node run.js             # 正常启动(空库自动播种虚构样本)
npm test                # 运行全部测试(23 个)
```

启动后访问:

| 页面 | 地址 | 说明 |
|---|---|---|
| 楼层屏 | http://localhost:8080/floor.html | 床位图 + 实时呼叫,高对比大字,呼叫位置与时间紧邻展示 |
| 护理员手机端 | http://localhost:8080/mobile.html | 只保留当前待办和确认动作;值班长登录出现派单/急救/误触核对工作台 |
| 夜巡任务 | http://localhost:8080/patrol.html | 巡更计划与打卡,漏检单独提醒 |
| 交班记录 | http://localhost:8080/handover.html | 链式交接,附件存本地 |
| 响应统计 | http://localhost:8080/stats.html | 响应时长、超时、急救、误触、连续呼叫 |

演示账号:护理员 `陈静/1001`、`刘洋/1002`(2F),`赵敏/1003`、`孙浩/1004`(3F);值班长 `周岚/2001`;管理员 `系统管理员/9001`。

## 呼叫状态机

```
按键 → OPEN 待派单 → ASSIGNED 已派单 → ACKED 已到床旁 → RESOLVED 已结案
OPEN/ASSIGNED 超阈值 → OVERDUE 超时未响应(仍可到达/结案;再超升级阈值 → 单独提醒值班长)
任意未结束状态 → ESCALATED 急救升级(普通结案被阻断,仅值班长可"急救结案")
误触 → FALSE_REVIEW 待核对 → 值班长核对 → CLOSED_FALSE(记录保留,不删除)
```

关键规则:

- **连续呼叫**:同一床位有未结束呼叫时再按键,合并进原呼叫(`repeat_count+1`),不新建、不重复派单。
- **不重复派发**:已派单呼叫再派给任何人(含护理员抢单)返回 `409 CALL_ALREADY_ASSIGNED`。
- **急救阻断**:`ESCALATED` 状态下普通结案返回 `409 CALL_ESCALATED_BLOCKED`,只能由值班长急救结案。
- **误触不删除**:必须填写说明,值班长核对通过才结案;核对不通过退回继续处理;全程留痕于 `call_events`。
- **住户外出**:住户登记外出/就医期间按钮触发,呼叫自动标记 `resident_away` 并单独通知值班长核实。
- **按钮离线**:离线按钮拒绝触发,离线事件通知值班长与楼层屏。
- **夜巡漏检**:超过计划时间+宽限(默认 15 分钟)未打卡 → `MISSED`,走独立 PATROL 通道单独提醒;补巡记为 `DONE_LATE`。
- **交班不断链**:上一班未确认接班前禁止新开交班(`409 HANDOVER_CHAIN_BROKEN`);交班快照未结束呼叫,交出人手上待办自动转移给接班人并留痕。

## 住户资料分级查看

| 岗位 | 可见字段 |
|---|---|
| 护理员 | 姓名、性别、年龄、床号、照护等级、行动能力、在院状态(限本楼层) |
| 值班长 | 以上 + 过敏史、健康备注 |
| 管理员 | 以上 + 紧急联系人、联系电话 |

## 界面设计

- 暖白底(`#faf6ee`)、深绿主色(`#1d5b45`)、急救红(`#b3261e`)**仅限急救状态**;超时/提醒用琥珀色区分。
- 所有告警同时配文字与图标徽章,不只依赖颜色;楼层屏大字号高对比,呼叫位置与时间在卡片顶部紧邻展示。
- 手机端只保留当前待办(我的呼叫、本楼层可领取、夜巡待办)与确认动作按钮。

## 架构

```
run.js                  入口:播种 + 演示案例 + 起服务
src/
  config.js             阈值/路径配置(可用环境变量覆盖)
  clock.js              可注入时钟(测试用)
  db.js                 SQLite(node:sqlite)与 schema
  errors.js             ApiError(HTTP 状态 + 业务码)
  services/
    calls.js            呼叫状态机 + 超时评估
    patrol.js           夜巡计划/打卡/漏检评估
    handover.js         交班链 + 附件落盘
    residents.js        住户资料按岗位分级
    stats.js            响应统计
    auth.js             登录/令牌/角色
  adapters/
    buttons.js          按钮模拟适配器(按键/心跳/离线)
    notify.js           通知模拟适配器(落 notifications 表 + 控制台)
  seed.js               虚构样本数据
  demo.js               演示案例生成
  server.js             node:http 路由 + 静态页
public/                 五个页面(原生 JS,2.5s 轮询)
test/                   node:test(23 个用例)
data/                   运行时生成:carecall.db + attachments/(已 gitignore)
```

事件全部存 SQLite(`calls` / `call_events` / `patrol_*` / `handovers` / `notifications`),交接附件存 `data/attachments/`。

## API 摘要

```
POST /api/login                       登录换取令牌
GET  /api/floors/:id/board            楼层屏数据(床位+进行中呼叫+播报,免登录只读)
POST /api/calls/press                 模拟按键 {button_code}
POST /api/calls/:id/assign|ack|resolve|escalate|emergency-resolve|false-trigger|false-verify
GET  /api/mobile/todos                当前待办(值班长附加工作台数据)
GET  /api/residents[?floor_id=]       住户资料(按岗位分级)
GET  /api/patrol/tonight|/api/patrol/missed, POST /api/patrol/:id/check
GET/POST /api/handovers, POST /api/handovers/:id/ack, GET /api/handovers/:id/attachment
GET  /api/stats/response              响应统计
POST /api/buttons/:code/offline|online  模拟按钮离线/上线
```

错误统一为 `{error:{code,message}}`,业务码见 `src/errors.js` 与各服务。

## 测试

```bash
npm test
```

- `test/calls.test.js` — 重复派发阻断、连续呼叫合并、急救阻断普通结案、误触说明+值班长核对、外出标记、离线拒触发
- `test/timeout.test.js` — 超时进入 OVERDUE、超时升级提醒值班长、超时后仍可到达结案、结案后不再评估
- `test/permissions.test.js` — 住户字段分级、护理员楼层限制、HTTP 层 401/403
- `test/handover.test.js` — 交班不断链、快照与待办转移、附件落盘、重复确认拒绝

## 环境变量

`PORT`(默认 8080)、`CARECALL_DATA`(数据目录)、`CARECALL_RESPONSE_TIMEOUT`(默认 180 秒)、`CARECALL_ESCALATE_REMINDER`(默认 600 秒)、`CARECALL_PATROL_GRACE`(默认 15 分钟)。
