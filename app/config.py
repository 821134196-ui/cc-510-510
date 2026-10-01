# 全部阈值为秒，可通过环境变量覆盖，便于演示与测试
import os


def _int(name, default):
    return int(os.environ.get(name, default))


# 呼叫处于「待派单」状态：提醒 / 自动急救升级
ACTIVE_WARN_SECONDS = _int("ACTIVE_WARN_SECONDS", 15)
ACTIVE_ESCALATE_SECONDS = _int("ACTIVE_ESCALATE_SECONDS", 30)
# 呼叫已派单但护理员未到床确认
ASSIGNED_WARN_SECONDS = _int("ASSIGN_WARN_SECONDS", 20)
ASSIGNED_ESCALATE_SECONDS = _int("ASSIGN_ESCALATE_SECONDS", 45)
# 按钮心跳超时
OFFLINE_SECONDS = _int("OFFLINE_SECONDS", 20)
# 夜巡窗口宽限
PATROL_GRACE_SECONDS = _int("PATROL_GRACE_SECONDS", 5)
# 同床位连续呼叫达到此次数自动急救升级
REPEAT_ESCALATE_COUNT = _int("REPEAT_ESCALATE_COUNT", 3)

TICK_SECONDS = _int("TICK_SECONDS", 2)
