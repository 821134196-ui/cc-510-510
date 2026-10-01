// 可注入时钟:测试中用 clock.set() 固定时间,服务层默认走这里。
let offsetMs = 0;

export const clock = {
  now() {
    return Date.now() + offsetMs;
  },
  set(ms) {
    offsetMs = ms - Date.now();
  },
  reset() {
    offsetMs = 0;
  },
};
