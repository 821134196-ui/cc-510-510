// 响应统计:响应时长、超时/急救/误触/连续呼叫、按护理员分组。
renderTopbar('stats.html');
let floors = [];

async function boot() {
  if (!Auth.staff) { renderLogin('app', boot); return; }
  floors = await api('/api/floors');
  document.getElementById('app').innerHTML = `
    <div class="card"><div class="row">
      <div><label>楼层</label><select id="s-floor"><option value="">全部</option>
        ${floors.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></div>
      <div><label>开始日期</label><input type="date" id="s-from"></div>
      <div><label>结束日期</label><input type="date" id="s-to"></div>
      <div style="display:flex;align-items:flex-end"><button onclick="loadStats()">查询</button></div>
    </div></div>
    <div id="s-result"></div>`;
  const today = new Date();
  document.getElementById('s-from').value = today.toISOString().slice(0, 10);
  document.getElementById('s-to').value = today.toISOString().slice(0, 10);
  loadStats();
}

window.loadStats = async () => {
  const fid = document.getElementById('s-floor').value;
  const from = document.getElementById('s-from').value;
  const to = document.getElementById('s-to').value;
  const q = new URLSearchParams();
  if (fid) q.set('floor_id', fid);
  if (from) q.set('from', new Date(from + 'T00:00:00').getTime());
  if (to) q.set('to', new Date(to + 'T23:59:59').getTime());
  const s = await api('/api/stats/response?' + q);
  render(s);
};

const sec = (v) => (v == null ? '—' : v >= 60 ? `${Math.floor(v / 60)}分${Math.round(v % 60)}秒` : `${Math.round(v)}秒`);

function render(s) {
  const cards = [
    ['呼叫总数', s.total, ''], ['平均响应', sec(s.ack_seconds.avg), ''], ['P90 响应', sec(s.ack_seconds.p90), ''],
    ['平均结案', sec(s.resolve_seconds.avg), ''], ['超时未响应', s.overdue_count, s.overdue_count ? 'emg' : ''],
    ['急救升级', s.escalated_count, s.escalated_count ? 'emg' : ''], ['误触(已说明)', s.false_trigger_count, ''],
    ['连续呼叫次数', s.repeat_press_total, ''], ['外出期间触发', s.resident_away_count, ''],
  ];
  const perCg = Object.entries(s.per_caregiver);
  document.getElementById('s-result').innerHTML = `
    <div class="stat-cards">${cards.map(([l, v, c]) => `
      <div class="stat-card"><div class="num ${c}">${v}</div><div class="lbl">${l}</div></div>`).join('')}
    </div>
    <div class="card">
      <h2>按护理员</h2>
      <table class="grid"><tr><th>护理员</th><th>被派单</th><th>到达确认</th><th>结案</th><th>发生超时</th></tr>
      ${perCg.length ? perCg.map(([name, c]) => `<tr><td>${esc(name)}</td><td>${c.assigned}</td><td>${c.acked}</td><td>${c.resolved}</td><td>${c.overdue}</td></tr>`).join('')
        : '<tr><td colspan="5" class="muted">该时段暂无数据</td></tr>'}</table>
    </div>
    <div class="card">
      <h2>状态分布</h2>
      <table class="grid"><tr><th>状态</th><th>数量</th></tr>
      ${Object.entries(s.by_status).map(([k, v]) => `<tr><td>${chip(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">暂无数据</td></tr>'}</table>
    </div>`;
}

boot();
