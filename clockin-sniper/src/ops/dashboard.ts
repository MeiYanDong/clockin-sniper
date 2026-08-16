export type DashboardSemanticState =
  | "WATCHING"
  | "ARMED"
  | "SIGNED"
  | "BROADCAST"
  | "RECEIPT"
  | "POSITION"
  | "EXITED";

export interface DashboardLane {
  readonly laneId: string;
  readonly walletLabel: string;
  readonly targetFeeBps: number;
  readonly observedFeeBps?: number;
  readonly transportState?: "ACCEPTED" | "KNOWN" | "UNKNOWN" | "REJECTED";
  readonly receiptState?: "SUCCESS" | "REVERTED" | "SUCCESS_NO_TOKENS";
  readonly tokenOutRaw?: string;
  readonly principalRaw: string;
  readonly gasCostRaw?: string;
  readonly signed: boolean;
}

export interface DashboardModel {
  readonly title: string;
  readonly phase: string;
  readonly latestBlock: string;
  readonly lagBlocks: number;
  readonly factory: {
    readonly candidateCount: number;
    readonly profileId: string;
    readonly revision: number;
    readonly state: string;
  };
  readonly identity: {
    readonly token: string;
    readonly pool: string;
    readonly creator: string;
    readonly caState: string;
  };
  readonly mechanism: {
    readonly declaredFeeBps?: number;
    readonly effectiveDragBps?: number;
    readonly capRaw: string;
    readonly inWindow: boolean;
  };
  readonly lanes: readonly DashboardLane[];
  readonly position: {
    readonly principalRaw: string;
    readonly gasRaw: string;
    readonly tokenRemainingRaw: string;
    readonly recoveredPrincipalRaw: string;
    readonly runnerState: string;
  };
  readonly routes: readonly {
    readonly routeId: string;
    readonly kind: string;
    readonly netOutputRaw: string;
    readonly state: string;
  }[];
  readonly recentEvents: readonly {
    readonly time: string;
    readonly kind: "ERROR" | "ACTION" | "INFO";
    readonly message: string;
  }[];
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function laneSemanticState(lane: DashboardLane): DashboardSemanticState {
  if (lane.receiptState === "SUCCESS" && BigInt(lane.tokenOutRaw ?? "0") > 0n) return "POSITION";
  if (lane.receiptState !== undefined) return "RECEIPT";
  if (lane.transportState !== undefined) return "BROADCAST";
  if (lane.signed) return "SIGNED";
  return lane.observedFeeBps !== undefined && lane.observedFeeBps <= lane.targetFeeBps
    ? "ARMED"
    : "WATCHING";
}

function short(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function renderOpsDashboard(model: DashboardModel): string {
  const laneRows = model.lanes
    .map((lane) => {
      const semantic = laneSemanticState(lane);
      return `<tr>
        <td><span class="lane-index">${escapeHtml(lane.laneId)}</span></td>
        <td>${escapeHtml(lane.walletLabel)}</td>
        <td>${(lane.targetFeeBps / 100).toFixed(2)}%</td>
        <td>${lane.observedFeeBps === undefined ? "—" : `${(lane.observedFeeBps / 100).toFixed(2)}%`}</td>
        <td>${escapeHtml(lane.principalRaw)}</td>
        <td>${escapeHtml(lane.gasCostRaw ?? "—")}</td>
        <td>${escapeHtml(lane.tokenOutRaw ?? "—")}</td>
        <td><span class="state state-${semantic.toLowerCase()}">${semantic}</span></td>
      </tr>`;
    })
    .join("");
  const routeRows = model.routes
    .map(
      (route) => `<div class="route">
        <div><span class="route-kind">${escapeHtml(route.kind)}</span><strong>${escapeHtml(route.routeId)}</strong></div>
        <div class="route-net">${escapeHtml(route.netOutputRaw)}</div>
        <span class="route-state">${escapeHtml(route.state)}</span>
      </div>`,
    )
    .join("");
  const eventRows = model.recentEvents
    .map(
      (event) => `<li class="event event-${event.kind.toLowerCase()}">
        <time>${escapeHtml(event.time)}</time><span>${escapeHtml(event.kind)}</span><p>${escapeHtml(event.message)}</p>
      </li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="3"><title>${escapeHtml(model.title)}</title>
  <style>
    :root{--ink:#0b1110;--panel:#111917;--line:#293632;--chalk:#d8e3dc;--muted:#75877f;--mint:#63f2bd;--amber:#ffbd59;--red:#ff6b5f;--paper:#e8efe9}
    *{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--chalk);font-family:"IBM Plex Mono","SFMono-Regular",Menlo,monospace;font-size:13px;letter-spacing:-.01em}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(255,255,255,.012) 4px);mix-blend-mode:screen}
    main{max-width:1480px;margin:0 auto;padding:28px}.masthead{display:grid;grid-template-columns:1.8fr 1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line)}
    .masthead>div{background:var(--panel);padding:22px}.eyebrow{color:var(--mint);font-size:11px;text-transform:uppercase;letter-spacing:.16em}h1{font-family:Georgia,"Songti SC",serif;font-size:38px;font-weight:400;margin:7px 0 0;letter-spacing:-.045em}.metric b{display:block;font-size:24px;color:var(--paper);margin-top:8px}.metric small{color:var(--muted)}
    .signal-strip{margin:16px 0;display:flex;align-items:center;gap:12px;border:1px solid var(--line);padding:11px 14px;background:#0e1513}.pulse{width:9px;height:9px;border-radius:50%;background:var(--mint);box-shadow:0 0 16px var(--mint);animation:pulse 1.8s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}.signal-strip strong{color:var(--mint)}
    .grid{display:grid;grid-template-columns:minmax(0,2.1fr) minmax(290px,.9fr);gap:16px}.panel{border:1px solid var(--line);background:var(--panel)}.panel-head{display:flex;justify-content:space-between;align-items:center;padding:13px 16px;border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:var(--muted)}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 13px;border-bottom:1px solid #1f2a27;white-space:nowrap}th{font-size:10px;color:var(--muted);font-weight:500;text-transform:uppercase}.lane-index{color:var(--mint)}.state{display:inline-block;border:1px solid var(--line);padding:4px 7px;font-size:10px;letter-spacing:.08em}.state-position,.state-exited{color:var(--mint);border-color:#2d765c}.state-broadcast,.state-receipt{color:var(--amber);border-color:#715c32}.state-watching{color:var(--muted)}
    .identity{padding:16px;display:grid;gap:12px}.identity div{display:grid;grid-template-columns:86px 1fr;gap:8px}.identity dt{color:var(--muted)}.identity dd{margin:0;overflow:hidden;text-overflow:ellipsis}.mechanism{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line);border-top:1px solid var(--line)}.mechanism div{background:var(--panel);padding:14px}.mechanism small{display:block;color:var(--muted);margin-bottom:7px}.mechanism b{font-size:18px;font-weight:500}
    .routes{padding:12px}.route{display:grid;grid-template-columns:1fr auto;gap:5px;padding:12px 4px;border-bottom:1px solid #23302c}.route-kind{color:var(--amber);font-size:9px;margin-right:8px}.route-net{font-size:17px;color:var(--mint)}.route-state{grid-column:1/3;color:var(--muted);font-size:10px}.event-list{list-style:none;padding:8px 14px;margin:0}.event{display:grid;grid-template-columns:72px 52px 1fr;gap:8px;border-bottom:1px solid #23302c;padding:10px 0}.event time,.event span{color:var(--muted);font-size:10px}.event p{margin:0}.event-error p{color:var(--red)}
    .position-bar{margin-top:16px;display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--line);border:1px solid var(--line)}.position-bar div{background:var(--panel);padding:14px}.position-bar small{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;margin-bottom:7px}.position-bar b{font-size:16px;font-weight:500}
    @media(max-width:900px){main{padding:12px}.masthead,.grid{grid-template-columns:1fr}.masthead{gap:1px}.position-bar{grid-template-columns:1fr 1fr}.table-wrap{overflow:auto}h1{font-size:30px}}
    @media(prefers-reduced-motion:reduce){.pulse{animation:none}}
  </style>
</head>
<body><main>
  <section class="masthead"><div><span class="eyebrow">Robinhood Chain · Evidence Console</span><h1>${escapeHtml(model.title)}</h1></div><div class="metric"><small>Latest canonical block</small><b>${escapeHtml(model.latestBlock)}</b><small>lag ${escapeHtml(model.lagBlocks)} blocks</small></div><div class="metric"><small>Operational phase</small><b>${escapeHtml(model.phase)}</b><small>${escapeHtml(model.factory.state)} / rev ${escapeHtml(model.factory.revision)}</small></div></section>
  <div class="signal-strip"><span class="pulse"></span><strong>${escapeHtml(model.phase)}</strong><span>accepted / known / unknown 均只代表传输，不代表成交</span></div>
  <div class="grid"><section class="panel"><div class="panel-head"><span>Ten independent entry lanes</span><span>${escapeHtml(model.lanes.length)} lanes</span></div><div class="table-wrap"><table><thead><tr><th>Lane</th><th>Wallet</th><th>Target fee</th><th>Observed</th><th>Principal</th><th>Gas</th><th>Token out</th><th>Evidence state</th></tr></thead><tbody>${laneRows}</tbody></table></div></section>
  <aside><section class="panel"><div class="panel-head"><span>Frozen identity</span><span>${escapeHtml(model.identity.caState)}</span></div><dl class="identity"><div><dt>Token</dt><dd title="${escapeHtml(model.identity.token)}">${escapeHtml(short(model.identity.token))}</dd></div><div><dt>Pool</dt><dd title="${escapeHtml(model.identity.pool)}">${escapeHtml(short(model.identity.pool))}</dd></div><div><dt>Creator</dt><dd title="${escapeHtml(model.identity.creator)}">${escapeHtml(short(model.identity.creator))}</dd></div><div><dt>Profile</dt><dd>${escapeHtml(model.factory.profileId)} · ${escapeHtml(model.factory.candidateCount)} candidates</dd></div></dl><div class="mechanism"><div><small>Declared fee</small><b>${model.mechanism.declaredFeeBps === undefined ? "UNKNOWN" : `${(model.mechanism.declaredFeeBps / 100).toFixed(2)}%`}</b></div><div><small>Effective drag</small><b>${model.mechanism.effectiveDragBps === undefined ? "UNKNOWN" : `${(model.mechanism.effectiveDragBps / 100).toFixed(2)}%`}</b></div><div><small>Cap</small><b>${escapeHtml(model.mechanism.capRaw)}</b></div><div><small>Window</small><b>${model.mechanism.inWindow ? "OPEN" : "CLOSED"}</b></div></div></section>
  <section class="panel" style="margin-top:16px"><div class="panel-head"><span>Executable exit routes</span><span>${escapeHtml(model.routes.length)}</span></div><div class="routes">${routeRows || "<p style='color:var(--muted)'>NO EXECUTABLE ROUTE</p>"}</div></section><section class="panel" style="margin-top:16px"><div class="panel-head"><span>Recent audit</span><span>append-only</span></div><ol class="event-list">${eventRows}</ol></section></aside></div>
  <section class="position-bar"><div><small>Actual principal</small><b>${escapeHtml(model.position.principalRaw)}</b></div><div><small>Gas paid</small><b>${escapeHtml(model.position.gasRaw)}</b></div><div><small>Token remaining</small><b>${escapeHtml(model.position.tokenRemainingRaw)}</b></div><div><small>Principal recovered</small><b>${escapeHtml(model.position.recoveredPrincipalRaw)}</b></div><div><small>Runner</small><b>${escapeHtml(model.position.runnerState)}</b></div></section>
</main></body></html>`;
}
