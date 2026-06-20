// ─── 定数 ───────────────────────────────────────────────
const SHIPMENT_MASTER = {
  shipment_id: "SHP-001",
  hub_id: "HUB-KUSATSU-TANAKAMI",
  destination_address: "東京都港区芝公園4-2-8（東京タワー）",
  desired_arrival_date: "2026-06-21",
  weight_kg: 8.5,
  quantity: 2,
  contents: "精密機器部品",
};

const ROUTES_MASTER = [
  { leg_app: "app02", from: "通天閣", to: "草津田上IC", mode: "一般道・非自動運転", distance_km: 50, speed_kmh: 50 },
  { leg_app: "app03", from: "草津田上IC（ハブ内）", to: "草津田上IC（ハブ内）", mode: "ハブ仕分け", distance_km: 0, speed_kmh: 0, fixed_minutes: 30 },
  { leg_app: "app04", from: "草津田上IC", to: "綾瀬IC", mode: "高速道路・自動運転", distance_km: 450, speed_kmh: 90 },
  { leg_app: "app05", from: "綾瀬IC（ハブ内）", to: "綾瀬IC（ハブ内）", mode: "ハブ仕分け", distance_km: 0, speed_kmh: 0, fixed_minutes: 30 },
  { leg_app: "app06", from: "綾瀬IC", to: "東京タワー", mode: "一般道・非自動運転", distance_km: 30, speed_kmh: 40 },
];

const APP_LABELS = {
  app01: "①発荷主", app02: "②輸送", app03: "③発地ハブ",
  app04: "④輸送(自動)", app05: "⑤着地ハブ", app06: "⑥輸送", app07: "⑦着荷主",
};

const APP_ICONS = {
  app01: "🏭", app02: "🚚", app03: "🏢",
  app04: "🤖", app05: "🏢", app06: "🚐", app07: "🗼",
};

// ─── 状態 ───────────────────────────────────────────────
let currentState = "IDLE";
let exchangeLog = [];
let idChain = { shipment_id: null, id_chain: [] };
let currentPlan = null;
let appReports = {};   // app01〜07 の report を保存
let simRunning = false;

// ─── ユーティリティ ───────────────────────────────────────
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function nowTime() { return new Date().toLocaleTimeString("ja-JP"); }

function yyyymmdd(date) { return date.toISOString().slice(0, 10).replace(/-/g, ""); }

function randomAlpha(n) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ─── 計画フェーズ ─────────────────────────────────────────
function calculateMinutes(route) {
  if (route.speed_kmh > 0) return Math.round((route.distance_km / route.speed_kmh) * 60 * 10) / 10;
  return route.fixed_minutes || 30;
}

function createPlan(shipment) {
  const legs = ROUTES_MASTER.map((route, i) => ({
    seq: i + 1,
    leg_id: `LEG-${String(i + 1).padStart(2, "0")}`,
    app: route.leg_app,
    from: route.from,
    to: route.to,
    mode: route.mode,
    distance_km: route.distance_km,
    speed_kmh: route.speed_kmh,
    estimated_minutes: calculateMinutes(route),
  }));
  const totalMinutes = legs.reduce((sum, l) => sum + l.estimated_minutes, 0);
  return {
    plan_id: "PLAN-001",
    shipment_id: shipment.shipment_id,
    created_at: new Date().toISOString(),
    legs,
    total_estimated_minutes: totalMinutes,
  };
}

// ─── ID 発行 ──────────────────────────────────────────────
function genId01() { return `TK-ORD-${yyyymmdd(new Date())}-001`; }
function genId02() { return `CA-WAYBILL-${String(Math.floor(Math.random() * 999999)).padStart(6, "0")}`; }
function genId03() { return `KST-IN-${yyyymmdd(new Date())}-001`; }
function genId04() { return `AUTO-JOB-${randomAlpha(8)}`; }
function genId05() { const d = new Date(); d.setDate(d.getDate() + 1); return `AYS-IN-${yyyymmdd(d)}-001`; }
function genId06() { return `CB-WAYBILL-${String(Math.floor(Math.random() * 999999)).padStart(6, "0")}`; }
function genId07() { const d = new Date(); d.setDate(d.getDate() + 1); return `TT-RCV-${yyyymmdd(d)}-001`; }

// ─── ログ ─────────────────────────────────────────────────
function logExchange(app, eventName, shipmentId, extra = {}) {
  exchangeLog.push({
    timestamp: nowTime(),
    app,
    event: eventName,
    shipment_id: shipmentId,
    ...extra,
  });
  renderExchangeLogTab();
  renderAppTab(app);
}

function logInstruction(targetApp, leg, prevRef, shipmentId) {
  const inst = {
    instruction_id: `OS-INST-${targetApp.toUpperCase()}`,
    issued_at: nowTime(),
    target_app: targetApp,
    shipment_id: shipmentId,
    leg_id: leg.leg_id,
    from_location: leg.from,
    to_location: leg.to,
    prev_ref: prevRef,
  };
  exchangeLog.push({ ...inst, timestamp: inst.issued_at, app: "物流OS", event: `${APP_LABELS[targetApp]}へ指示送信` });
  renderExchangeLogTab();
  return inst;
}

// ─── 名寄せ台帳 ───────────────────────────────────────────
function appendToChain(shipmentId, app, ownId, prevRef) {
  if (idChain.shipment_id !== shipmentId) idChain = { shipment_id: shipmentId, id_chain: [] };
  idChain.id_chain.push({ app, own_id: ownId, prev_ref: prevRef });
  renderIdChainTab();
}

function resetChain() { idChain = { shipment_id: null, id_chain: [] }; }

// ─── 各 app 実行 ──────────────────────────────────────────
async function runApp01() {
  const ownId = genId01();
  logExchange("app01", "出荷準備完了", SHIPMENT_MASTER.shipment_id, {
    own_id: ownId, weight_kg: SHIPMENT_MASTER.weight_kg, quantity: SHIPMENT_MASTER.quantity,
  });
  await wait(3000);
  logExchange("app01", "出荷完了・配送業者へ引渡", SHIPMENT_MASTER.shipment_id, { own_id: ownId });
  return { ...SHIPMENT_MASTER, own_id: ownId, prev_ref: null };
}

async function runApp02(instruction) {
  const ownId = genId02();
  logExchange("app02", "受取（輸送開始）", instruction.shipment_id, {
    own_id: ownId, prev_ref: instruction.prev_ref,
    from: instruction.from_location, to: instruction.to_location,
  });
  await wait(3000);
  logExchange("app02", "発地ハブへ引渡（輸送終了）", instruction.shipment_id, { own_id: ownId });
  return { app: "app02", own_id: ownId, prev_ref: instruction.prev_ref, shipment_id: instruction.shipment_id, completed_at: new Date().toISOString() };
}

async function runApp03(instruction) {
  const ownId = genId03();
  logExchange("app03", "受取（ハブ入庫）", instruction.shipment_id, {
    own_id: ownId, prev_ref: instruction.prev_ref,
    weight_kg: SHIPMENT_MASTER.weight_kg, quantity: SHIPMENT_MASTER.quantity,
  });
  await wait(3000);
  logExchange("app03", "仕分け完了・自動運転車へ引渡（ハブ出庫）", instruction.shipment_id, { own_id: ownId });
  return { app: "app03", own_id: ownId, prev_ref: instruction.prev_ref, shipment_id: instruction.shipment_id, completed_at: new Date().toISOString() };
}

async function runApp04(instruction) {
  const ownId = genId04();
  logExchange("app04", "受取（自動運転輸送開始）", instruction.shipment_id, {
    own_id: ownId, prev_ref: instruction.prev_ref,
    from: instruction.from_location, to: instruction.to_location,
  });
  await wait(3000);
  logExchange("app04", "着地ハブへ到着・引渡（輸送終了）", instruction.shipment_id, { own_id: ownId });
  return { app: "app04", own_id: ownId, prev_ref: instruction.prev_ref, shipment_id: instruction.shipment_id, completed_at: new Date().toISOString() };
}

async function runApp05(instruction) {
  const ownId = genId05();
  logExchange("app05", "受取（ハブ入庫）", instruction.shipment_id, {
    own_id: ownId, prev_ref: instruction.prev_ref,
    weight_kg: SHIPMENT_MASTER.weight_kg, quantity: SHIPMENT_MASTER.quantity,
  });
  await wait(3000);
  logExchange("app05", "仕分け完了・配送業者へ引渡（ハブ出庫）", instruction.shipment_id, { own_id: ownId });
  return { app: "app05", own_id: ownId, prev_ref: instruction.prev_ref, shipment_id: instruction.shipment_id, completed_at: new Date().toISOString() };
}

async function runApp06(instruction) {
  const ownId = genId06();
  logExchange("app06", "受取（最終配送開始）", instruction.shipment_id, {
    own_id: ownId, prev_ref: instruction.prev_ref,
    from: instruction.from_location, to: instruction.to_location,
  });
  await wait(3000);
  logExchange("app06", "着荷主へ到着・引渡（配送完了）", instruction.shipment_id, { own_id: ownId });
  return { app: "app06", own_id: ownId, prev_ref: instruction.prev_ref, shipment_id: instruction.shipment_id, completed_at: new Date().toISOString() };
}

async function runApp07(instruction) {
  const ownId = genId07();
  logExchange("app07", "受取・検品開始", instruction.shipment_id, {
    own_id: ownId, prev_ref: instruction.prev_ref,
    quantity: SHIPMENT_MASTER.quantity, contents: SHIPMENT_MASTER.contents,
  });
  await wait(3000);
  logExchange("app07", "検品完了・荷物受領確認", instruction.shipment_id, { own_id: ownId, status: "正常受領" });
  return { app: "app07", own_id: ownId, prev_ref: instruction.prev_ref, shipment_id: instruction.shipment_id, completed_at: new Date().toISOString() };
}

const APP_RUNNERS = { app02: runApp02, app03: runApp03, app04: runApp04, app05: runApp05, app06: runApp06, app07: runApp07 };

// ─── 状態機械メインループ ──────────────────────────────────
async function runSimulation() {
  if (simRunning) return;
  simRunning = true;

  // app01
  setState("APP01_RUNNING");
  const shipment = await runApp01();
  appReports["app01"] = shipment;
  setState("APP01_DONE");

  // 計画フェーズ
  setState("OS_PLANNING");
  await wait(500);
  currentPlan = createPlan(shipment);
  logExchange("物流OS", `輸送プラン作成完了（合計${currentPlan.total_estimated_minutes}分）`, shipment.shipment_id, { plan_id: currentPlan.plan_id });
  setState("OS_PLAN_READY");
  renderOsTab();
  await wait(500);

  // 名寄せ台帳にapp01を追加
  appendToChain(shipment.shipment_id, "app01", shipment.own_id, null);

  let prevRef = shipment.own_id;

  // app02〜07（legに沿って順番に）
  for (const leg of currentPlan.legs) {
    const appKey = leg.app;
    setState(`OS_INSTRUCTING_${appKey.toUpperCase()}`);
    const instruction = logInstruction(appKey, leg, prevRef, shipment.shipment_id);
    renderOsTab();

    setState(`${appKey.toUpperCase()}_RUNNING`);
    const report = await APP_RUNNERS[appKey](instruction);
    appReports[appKey] = report;
    setState(`${appKey.toUpperCase()}_DONE`);

    appendToChain(shipment.shipment_id, appKey, report.own_id, report.prev_ref);
    prevRef = report.own_id;
    renderOsTab();
  }

  // app07完了後に着荷主タブ分の dummy instruction を記録
  setState("APP07_DONE");
  renderOsTab();
  simRunning = false;
}

function setState(s) {
  currentState = s;
  renderOsTab();
  updateTabBadges();
}

// ─── レンダリング ─────────────────────────────────────────
function renderOsTab() {
  const el = document.getElementById("tab-os-content");
  if (!el) return;

  const stateLabel = getStateLabelHtml(currentState);
  let planHtml = "";
  if (currentPlan) {
    const rows = currentPlan.legs.map(l => `
      <tr>
        <td>${l.leg_id}</td>
        <td>${APP_LABELS[l.app]}</td>
        <td>${l.from}</td>
        <td>${l.to}</td>
        <td>${l.mode}</td>
        <td style="text-align:right">${l.distance_km > 0 ? l.distance_km + " km" : "—"}</td>
        <td style="text-align:right">${l.estimated_minutes} 分</td>
      </tr>`).join("");
    const h = Math.floor(currentPlan.total_estimated_minutes / 60);
    const m = currentPlan.total_estimated_minutes % 60;
    planHtml = `
      <div class="card">
        <h2>輸送プラン（${currentPlan.plan_id}）</h2>
        <table class="plan-table">
          <thead><tr><th>LEG</th><th>担当</th><th>出発</th><th>到着</th><th>モード</th><th>距離</th><th>所要時間</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="plan-total" style="margin-top:10px">合計所要時間: ${currentPlan.total_estimated_minutes}分（${h}時間${m}分）</p>
      </div>`;
  }

  const steps = ["app01","app02","app03","app04","app05","app06","app07"];
  const nums   = ["①","②","③","④","⑤","⑥","⑦"];
  const progHtml = steps.map((app, i) => {
    const upper = app.toUpperCase();
    let cls = "";
    if (currentState === `${upper}_RUNNING` || currentState === `OS_INSTRUCTING_${upper}`) cls = "running";
    else if (currentState === `${upper}_DONE` || isAfterApp(app)) cls = "done";
    const arrow = i < steps.length - 1 ? `<div class="prog-arrow">→</div>` : "";
    return `<div class="prog-step"><div class="prog-circle ${cls}">${nums[i]}</div><div class="prog-label">${app}</div></div>${arrow}`;
  }).join("");

  el.innerHTML = `
    <div class="card">
      <h2>【計画フェーズ】</h2>
      <p>状態: ${stateLabel}</p>
    </div>
    ${planHtml}
    <div class="card">
      <h2>【実行フェーズ】</h2>
      <p style="margin-bottom:8px">現在の状態: <strong>${currentState}</strong></p>
      <div class="progress-bar">${progHtml}</div>
    </div>`;
}

function isAfterApp(app) {
  const order = ["app01","app02","app03","app04","app05","app06","app07"];
  const done = ["APP01_DONE","APP02_DONE","APP03_DONE","APP04_DONE","APP05_DONE","APP06_DONE","APP07_DONE",
                "OS_INSTRUCTING_APP02","OS_INSTRUCTING_APP03","OS_INSTRUCTING_APP04",
                "OS_INSTRUCTING_APP05","OS_INSTRUCTING_APP06","OS_INSTRUCTING_APP07",
                "APP02_RUNNING","APP03_RUNNING","APP04_RUNNING","APP05_RUNNING","APP06_RUNNING","APP07_RUNNING"];
  const idx = order.indexOf(app);
  const curIdx = order.findIndex(a => currentState.includes(a.toUpperCase()));
  if (currentState === "OS_PLANNING" || currentState === "OS_PLAN_READY") return idx === 0;
  if (currentState === `${app.toUpperCase()}_DONE`) return true;
  if (curIdx > idx) return true;
  return false;
}

function getStateLabelHtml(s) {
  if (s === "IDLE") return `<span class="badge badge-idle">待機中</span>`;
  if (s === "OS_PLANNING") return `<span class="badge badge-running">輸送プラン作成中...</span>`;
  if (s === "OS_PLAN_READY") return `<span class="badge badge-plan">輸送プラン完成 ✅</span>`;
  if (s.includes("_RUNNING")) return `<span class="badge badge-running">処理中...</span>`;
  if (s.includes("_DONE")) return `<span class="badge badge-done">完了 ✅</span>`;
  if (s.includes("OS_INSTRUCTING")) return `<span class="badge badge-running">指示送信中...</span>`;
  return `<span class="badge badge-idle">${s}</span>`;
}

function renderAppTab(appKey) {
  const el = document.getElementById(`tab-${appKey}-content`);
  if (!el) return;
  const label = APP_LABELS[appKey] || appKey;
  const icon = APP_ICONS[appKey] || "📦";
  const report = appReports[appKey];
  const logs = exchangeLog.filter(e => e.app === appKey);

  const upper = appKey.toUpperCase();
  let statusBadge = `<span class="badge badge-idle">未処理</span>`;
  if (currentState === `${upper}_RUNNING` || currentState === `OS_INSTRUCTING_${upper}`)
    statusBadge = `<span class="badge badge-running">処理中...</span>`;
  else if (report) statusBadge = `<span class="badge badge-done">完了 ✅</span>`;

  const reportHtml = report ? `
    <div class="card">
      <h3>発行ID</h3>
      <div class="app-info-grid">
        <div class="app-info-item"><div class="label">own_id</div><div class="value" style="font-family:monospace;color:#065F46">${report.own_id}</div></div>
        <div class="app-info-item"><div class="label">prev_ref</div><div class="value" style="font-family:monospace;color:#6B7280">${report.prev_ref || "(起点)"}</div></div>
        <div class="app-info-item"><div class="label">shipment_id</div><div class="value" style="font-family:monospace">${report.shipment_id}</div></div>
        ${report.completed_at ? `<div class="app-info-item"><div class="label">完了時刻</div><div class="value">${new Date(report.completed_at).toLocaleTimeString("ja-JP")}</div></div>` : ""}
      </div>
    </div>` : "";

  const eventsHtml = logs.length ? `
    <div class="card">
      <h3>イベント記録</h3>
      <ul class="event-list">
        ${logs.map(l => `<li><span class="event-time">${l.timestamp}</span><span class="event-text">${l.event}</span></li>`).join("")}
      </ul>
    </div>` : "";

  el.innerHTML = `
    <div class="card">
      <div class="app-icon">${icon}</div>
      <h2 style="text-align:center">${label}</h2>
      <p style="text-align:center;margin-top:6px">状態: ${statusBadge}</p>
    </div>
    ${reportHtml}
    ${eventsHtml}`;
}

function renderAllAppTabs() {
  ["app01","app02","app03","app04","app05","app06","app07"].forEach(renderAppTab);
}

function renderIdChainTab() {
  const el = document.getElementById("tab-chain-content");
  if (!el) return;
  if (!idChain.shipment_id) {
    el.innerHTML = `<div class="card"><p style="color:#9CA3AF">シミュレーション開始後に表示されます。</p></div>`;
    return;
  }
  const items = idChain.id_chain.map((entry, i) => {
    const label = APP_LABELS[entry.app] || entry.app;
    const icon = APP_ICONS[entry.app] || "📦";
    const arrow = i < idChain.id_chain.length - 1 ? `<div class="chain-arrow">↓</div>` : "";
    return `
      <div class="chain-item">
        <div class="chain-app">${icon} ${label}</div>
        <div class="chain-ids">
          <div class="chain-own">own_id: ${entry.own_id}</div>
          <div class="chain-prev">prev_ref: ${entry.prev_ref || "(起点)"}</div>
        </div>
      </div>
      ${arrow}`;
  }).join("");

  el.innerHTML = `
    <div class="card">
      <h2>🔗 名寄せ台帳（バケツリレー型参照チェーン）</h2>
      <p style="margin-bottom:12px;color:#6B7280;font-size:13px">shipment_id: <strong>${idChain.shipment_id}</strong></p>
      ${items}
    </div>`;
}

function renderExchangeLogTab() {
  const el = document.getElementById("tab-log-content");
  if (!el) return;
  if (!exchangeLog.length) {
    el.innerHTML = `<div class="card"><p style="color:#9CA3AF">ログはまだありません。</p></div>`;
    return;
  }
  const rows = exchangeLog.map(e => {
    const isOs = e.app === "物流OS";
    const appCls = isOs ? "log-os" : "log-app";
    return `<tr><td>${e.timestamp}</td><td class="${appCls}">${e.app}</td><td>${e.event}</td><td>${e.shipment_id || ""}</td></tr>`;
  }).join("");
  el.innerHTML = `
    <div class="log-wrap">
      <table class="log-table">
        <thead><tr><th>時刻</th><th>アプリ</th><th>イベント</th><th>Shipment ID</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  // 最下部にスクロール
  const wrap = el.querySelector(".log-wrap");
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function updateTabBadges() {
  // タブボタンの状態バッジは今回は省略（シンプルさ優先）
}

// ─── タブ切り替え ─────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll(".tab-content").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(el => el.classList.remove("active"));
  document.getElementById(`tab-${tabId}-content`).classList.add("active");
  document.querySelector(`[data-tab="${tabId}"]`).classList.add("active");
}

// ─── リスタート ───────────────────────────────────────────
function restart() {
  simRunning = false;
  exchangeLog = [];
  appReports = {};
  currentPlan = null;
  resetChain();
  currentState = "IDLE";
  renderOsTab();
  renderAllAppTabs();
  renderIdChainTab();
  renderExchangeLogTab();
  setTimeout(() => runSimulation(), 100);
}

// ─── 起動 ─────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // タブボタンにイベント設定
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  document.getElementById("restartBtn").addEventListener("click", restart);

  // 初期描画
  renderOsTab();
  renderAllAppTabs();
  renderIdChainTab();
  renderExchangeLogTab();

  // 自動開始
  runSimulation();
});
