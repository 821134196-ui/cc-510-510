import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const config = {
  rootDir: ROOT,
  dataDir: process.env.CARECALL_DATA || path.join(ROOT, 'data'),
  dbFile: process.env.CARECALL_DB || null, // null => <dataDir>/carecall.db
  attachmentsDir: process.env.CARECALL_ATTACHMENTS || null, // null => <dataDir>/attachments
  port: Number(process.env.PORT || 8080),

  // 呼叫响应阈值:超过即视为"超时未响应"
  responseTimeoutSec: Number(process.env.CARECALL_RESPONSE_TIMEOUT || 180),
  // 超时后仍未响应,向值班长发出升级提醒
  escalateReminderSec: Number(process.env.CARECALL_ESCALATE_REMINDER || 600),
  // 夜巡计划宽限(分钟),超过记为漏检并单独提醒
  patrolGraceMin: Number(process.env.CARECALL_PATROL_GRACE || 15),

  maxBodyBytes: 8 * 1024 * 1024,
};

export function resolvePaths(cfg = config) {
  return {
    dbPath: cfg.dbFile || path.join(cfg.dataDir, 'carecall.db'),
    attachmentsDir: cfg.attachmentsDir || path.join(cfg.dataDir, 'attachments'),
  };
}
