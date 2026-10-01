#!/usr/bin/env python3
"""一条本地命令启动：python run.py

启动后自动生成演示案例：
  · 按钮离线（B-103-1 心跳中断）
  · 呼叫超时未派单：15 秒提醒 / 30 秒自动急救升级
  · 派单后超时未到床：20 秒提醒 / 45 秒升级
  · 夜巡漏检（超窗任务，单独提醒）
另可在值班长台「演示控制」里手动按按钮、断/连心跳。
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.server import App, make_handler  # noqa: E402
from app import seed as seed_mod, config  # noqa: E402


def build_demo_cases(app: App) -> None:
    """直接造出/触发离线、超时与漏检案例，楼层屏立刻可见。"""
    db, svc, T = app.db, app.svc, time.time()

    # 1) 按钮离线：停掉模拟心跳并把最后心跳拨到超时阈值之前，首个监控周期即判离线
    app.buttons.simulate_offline("B-103-1")
    db.execute("UPDATE buttons SET online=1, last_heartbeat=? WHERE code='B-103-1'",
               (T - config.OFFLINE_SECONDS - 10,))

    # 2) 待派单超时（已到提醒阈值，未到升级阈值）
    c1 = svc.open_call(button_code="B-201-1", source_type="button")
    db.execute("UPDATE calls SET opened_at=? WHERE id=?",
               (T - config.ACTIVE_WARN_SECONDS - 2, c1["id"]))

    # 3) 待派单超时且已达升级阈值（首个监控周期自动急救升级）
    c2 = svc.open_call(button_code="B-201-2", source_type="button")
    db.execute("UPDATE calls SET opened_at=?, timeout_warned=1 WHERE id=?",
               (T - config.ACTIVE_ESCALATE_SECONDS - 1, c2["id"]))

    # 4) 已派单但护理员迟迟未到床（超时提醒）
    c3 = svc.open_call(button_code="B-202-1", source_type="button")
    svc.assign_call(c3["id"], 5)  # N3 护理员·赵雪
    db.execute("UPDATE calls SET assigned_at=?, timeout_warned=0 WHERE id=?",
               (T - config.ASSIGNED_WARN_SECONDS - 2, c3["id"]))

    # 5) 夜巡漏检：把一条待巡任务拨到巡查窗口结束之前
    task = db.q1("SELECT id FROM patrol_tasks WHERE status='pending' ORDER BY id LIMIT 1")
    if task:
        db.execute("UPDATE patrol_tasks SET due_at=?, window_end=? WHERE id=?",
                   (T - 900, T - 60, task["id"]))

    print("【演示案例已生成】")
    print("  · 按钮离线：一楼 103房1号床 B-103-1（心跳中断，将收离线提醒）")
    print("  · 超时未派单：二楼 201房1号床（提醒） / 201房2号床（自动急救升级）")
    print("  · 派单超时未到床：二楼 202房1号床，已派 N3 赵雪")
    print("  · 夜巡漏检：一条全护床位夜巡任务超窗（漏检单独提醒）")
    print("  · 也可用值班长台「演示控制」手动按按钮、断开心跳观察全流程")


def main() -> None:
    ap = argparse.ArgumentParser(description="养老机构呼叫与夜巡系统")
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    ap.add_argument("--db", default=os.environ.get("DB", "data/carecall.db"))
    ap.add_argument("--reset", action="store_true", help="删除旧数据库并重新播种虚构数据")
    ap.add_argument("--no-demo", action="store_true", help="不生成离线/超时/漏检演示案例")
    ap.add_argument("--demo", action="store_true",
                    help="即使数据库已存在也追加演示案例（默认仅新建库时生成）")
    args = ap.parse_args()

    if args.reset and Path(args.db).exists():
        for suffix in ("", "-wal", "-shm"):
            p = Path(args.db + suffix)
            if p.exists():
                p.unlink()

    app = App(args.db)
    created = seed_mod.seed(app.db)
    if created:
        print("已初始化虚构演示数据（3 个楼层、24 张床位、24 位虚构住户、6 名员工）")
    if (created or args.demo) and not args.no_demo:
        build_demo_cases(app)

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(app))
    print("-" * 64)
    print(f"服务已启动：http://localhost:{args.port}")
    print("  楼层屏     /screen   （高对比大字，无需登录）")
    print("  护理员端   /phone    （N1-N4，口令 0000）")
    print("  值班长台   /leader   （L1/L2，口令 1234）")
    print("  Ctrl+C 停止")
    print("-" * 64)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        app.buttons.stop()
        app.monitor.stop()


if __name__ == "__main__":
    main()
