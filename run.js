#!/usr/bin/env node
// 一条命令启动养老机构呼叫系统。
//   node run.js          正常启动(空库自动播种虚构样本)
//   node run.js --demo   启动并生成演示案例(按钮离线 + 超时未响应 + 连续呼叫 + 外出触发 + 夜巡漏检)
import path from 'node:path';
import fs from 'node:fs';
import { config, resolvePaths } from './src/config.js';
import { openDb } from './src/db.js';
import { clock } from './src/clock.js';
import { seedIfEmpty } from './src/seed.js';
import { generateDemoCases } from './src/demo.js';
import { createServer } from './src/server.js';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const portArg = args.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : config.port;

const { dbPath, attachmentsDir } = resolvePaths(config);
fs.mkdirSync(attachmentsDir, { recursive: true });

const db = openDb(dbPath);
const seeded = seedIfEmpty(db, clock.now());

const server = createServer({
  db,
  cfg: config,
  attachmentsDir,
  publicDir: path.join(config.rootDir, 'public'),
});

server.listen(port, () => {
  console.log('');
  console.log('  养老机构呼叫联动系统(所有住户数据均为虚构样本)');
  console.log('  ────────────────────────────────────────────');
  console.log(`  楼层屏(床位图+实时呼叫)  http://localhost:${port}/floor.html`);
  console.log(`  护理员手机端             http://localhost:${port}/mobile.html`);
  console.log(`  夜巡任务                 http://localhost:${port}/patrol.html`);
  console.log(`  交班记录                 http://localhost:${port}/handover.html`);
  console.log(`  响应统计                 http://localhost:${port}/stats.html`);
  console.log('  ────────────────────────────────────────────');
  console.log(`  数据库:${dbPath}  附件目录:${attachmentsDir}`);
  if (seeded) console.log('  已播种虚构样本数据(2 个楼层 / 14 位住户 / 6 名员工)');
  if (demo) {
    console.log('  正在生成演示案例...');
    for (const line of generateDemoCases(db, config, clock.now())) console.log('   • ' + line);
  }
  console.log('');
  console.log('  演示账号:护理员 陈静/1001(2F) 赵敏/1003(3F);值班长 周岚/2001;管理员 系统管理员/9001');
});
