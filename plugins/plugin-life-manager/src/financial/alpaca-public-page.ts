export function renderAlpacaPublicPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Life Manager autonomous Alpaca paper-trading evidence">
  <title>Life Manager — Alpaca Paper Agent</title>
  <style>
    :root{color-scheme:dark;--bg:#07110f;--panel:#0d1c18;--line:#23453b;--mint:#66f2bd;--text:#edf8f3;--muted:#91aaa0;--red:#ff8c8c}*{box-sizing:border-box}
    body{margin:0;background:radial-gradient(circle at 80% 0,#12382d 0,transparent 35%),var(--bg);color:var(--text);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
    main{width:min(1120px,calc(100% - 32px));margin:auto;padding:48px 0 72px}header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:28px}
    h1{font:700 clamp(32px,6vw,68px)/.95 system-ui,sans-serif;letter-spacing:-.06em;margin:8px 0 14px;max-width:760px}.eyebrow,.badge{color:var(--mint);text-transform:uppercase;letter-spacing:.14em;font-size:12px}.badge{border:1px solid var(--mint);border-radius:999px;padding:8px 12px;white-space:nowrap}
    .lede{color:var(--muted);max-width:680px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.card{background:linear-gradient(145deg,rgba(17,40,33,.95),rgba(9,24,20,.95));border:1px solid var(--line);border-radius:16px;padding:20px;min-width:0}.metric{grid-column:span 3}.wide{grid-column:span 8}.side{grid-column:span 4}.full{grid-column:1/-1}
    h2{font:650 17px system-ui,sans-serif;margin:0 0 16px}.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.value{font:650 28px system-ui,sans-serif;margin-top:7px}.positive{color:var(--mint)}.negative{color:var(--red)}
    .status{display:flex;gap:10px;align-items:center}.dot{width:8px;height:8px;border-radius:50%;background:var(--mint);box-shadow:0 0 16px var(--mint)}dl{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
    table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:400}.empty{color:var(--muted);padding:12px 0}.error{color:var(--red)}footer{color:var(--muted);font-size:11px;margin-top:20px}
    @media(max-width:800px){header{display:block}.badge{display:inline-block;margin-top:12px}.metric,.wide,.side{grid-column:1/-1}main{padding-top:28px}.card{padding:16px}}
  </style>
</head>
<body><main>
  <header><div><div class="eyebrow">Autonomous finance organ / ElizaOS</div><h1>Evidence, not a profit promise.</h1><p class="lede">Life Manager observes multiple markets, lets one model propose, applies deterministic portfolio vetoes, and executes accepted paper orders exactly once through Alpaca CLI.</p></div><div class="badge">Paper trading only</div></header>
  <section class="grid" aria-live="polite">
    <article class="card metric"><div class="label">Starting equity</div><div class="value" id="starting">—</div></article>
    <article class="card metric"><div class="label">Current equity</div><div class="value" id="equity">—</div></article>
    <article class="card metric"><div class="label">Total P&amp;L</div><div class="value" id="pnl">—</div></article>
    <article class="card metric"><div class="label">Unrealised P&amp;L</div><div class="value" id="unrealized">—</div></article>
    <article class="card wide"><h2>Latest model decision</h2><dl id="decision"><dt>Status</dt><dd>Loading official evidence…</dd></dl></article>
    <article class="card side"><h2>Reconciliation</h2><div class="status"><span class="dot"></span><span id="reconciliation">Loading…</span></div><p class="empty" id="observed"></p><div id="gate"></div></article>
    <article class="card full"><h2>Open positions</h2><div id="positions" class="empty">Loading…</div></article>
    <article class="card full"><h2>Broker fills</h2><div id="fills" class="empty">Loading…</div></article>
    <article class="card full"><h2>Decision → veto → effect timeline</h2><div id="timeline" class="empty">Loading…</div></article>
  </section>
  <footer>Read-only public projection · broker and fill identifiers redacted · no order-placement surface · paper results are not real revenue or a guarantee of future returns.</footer>
</main>
<script>
  const money=n=>typeof n==='number'?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n):'—';
  const text=(id,value)=>{document.getElementById(id).textContent=String(value??'—')};
  const tone=(id,n)=>{const el=document.getElementById(id);el.classList.remove('positive','negative');if(typeof n==='number')el.classList.add(n>=0?'positive':'negative')};
  const table=(id,headers,rows)=>{const host=document.getElementById(id);host.textContent='';if(!rows.length){host.textContent='None';host.className='empty';return}const t=document.createElement('table'),head=document.createElement('tr');headers.forEach(h=>{const th=document.createElement('th');th.textContent=h;head.append(th)});t.append(head);rows.forEach(values=>{const tr=document.createElement('tr');values.forEach(v=>{const td=document.createElement('td');td.textContent=String(v??'—');tr.append(td)});t.append(tr)});host.append(t)};
  fetch('/api/life-manager/alpaca/public',{headers:{accept:'application/json'}}).then(r=>{if(!r.ok)throw new Error('unavailable');return r.json()}).then(p=>{
    text('starting',money(p.startingEquityUsd));text('equity',money(p.equityUsd));text('pnl',money(p.totalPnlUsd));tone('pnl',p.totalPnlUsd);text('unrealized',money(p.unrealizedPnlUsd));tone('unrealized',p.unrealizedPnlUsd);
    const d=p.latestDecision||{},dl=document.getElementById('decision');dl.textContent='';[['Status',d.status],['Market',d.assetClass],['Candidate',d.candidateRef],['Thesis',d.thesis],['Expected value',money(d.expectedValueUsd)],['Maximum loss',money(d.maxLossUsd)],['Invalidation',d.invalidation],['Exit plan',d.exitPlan]].forEach(([k,v])=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=String(v??'—');dl.append(dt,dd)});
    text('reconciliation',p.reconciliation.status+' · '+p.reconciliation.positionCount+' positions · '+p.reconciliation.fillCount+' fills');text('observed','Observed '+p.observedAt);const g=p.latestGate;document.getElementById('gate').textContent=g?(g.allowed?'Gate: ALLOWED':'Gate veto: '+(g.reasons||[]).join(', ')):'Gate receipt pending';
    table('positions',['Symbol','Side','Qty','Entry','Current','Value','Unrealised'],(p.positions||[]).map(x=>[x.symbol,x.side,x.quantity,money(x.averageEntryPrice),money(x.currentPrice),money(x.marketValue),money(x.unrealizedPnl)]));
    table('fills',['Public fill','Public order','Symbol','Side','Qty','Price','Time'],(p.fills||[]).map(x=>[x.id,x.orderId,x.symbol,x.side,x.quantity,money(x.price),x.transactionAt]));
    table('timeline',['Effect','Status','Outcome','Created','Observed'],(p.timeline||[]).map(x=>[x.effectClass,x.status,x.outcome,x.createdAt,x.observedAt]));
  }).catch(()=>{document.querySelectorAll('.empty').forEach(el=>{el.textContent='Read-only evidence is temporarily unavailable.'});text('reconciliation','Unavailable');document.getElementById('reconciliation').className='error'});
</script></body></html>`;
}
