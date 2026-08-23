/**
 * The whole web panel: one self-contained page, no network fetches.
 *
 * Kept strictly ASCII on purpose. The bundler escapes non-ASCII characters into
 * `\uXXXX`, and this template is tagged `String.raw` (the client-side regex
 * needs its backslashes intact), so an escape would survive into the HTML
 * verbatim and render as literal `…`. HTML entities go through untouched.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>parley</title>
<style>
  :root {
    --bg:#fbfaf8; --panel:#fff; --ink:#1a1a19; --mute:#6f6d68; --line:#e6e3dd;
    --accent:#2f6f57; --warn:#9a6a00; --danger:#a33a2a; --human:#1f5f8b; --radius:10px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#131412; --panel:#1b1c19; --ink:#eceae5; --mute:#9a978f; --line:#2c2e29;
      --accent:#6fbf9a; --warn:#d9a441; --danger:#e0705c; --human:#74b3dd;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);overflow:hidden;
    font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;
    padding:14px 20px;border-bottom:1px solid var(--line)}
  h1{font-size:15px;margin:0;letter-spacing:.02em}
  .mode{padding:2px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
  .mode.advisory{color:var(--accent)} .mode.enforced{color:var(--danger)} .mode.off{color:var(--mute)}
  .grow{flex:1}
  .meta{color:var(--mute);font-size:12px}
  #conn.live{color:var(--accent)} #conn.down{color:var(--danger)}

  main{display:grid;grid-template-columns:minmax(260px,330px) 1fr;
    height:calc(100vh - 53px)}
  @media (max-width:820px){
    body{overflow:auto} main{grid-template-columns:1fr;height:auto}
  }
  aside{border-right:1px solid var(--line);overflow:auto;padding:16px 18px}
  section.feedwrap{display:flex;flex-direction:column;min-height:0}
  h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin:0 0 10px}

  .front{padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius);
    background:var(--panel);margin-bottom:8px}
  .front .top{display:flex;align-items:center;gap:8px}
  .dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--mute)}
  .dot.live{background:var(--accent)} .dot.stale{background:var(--danger)}
  .name{font-weight:600}
  .front .mission{color:var(--mute);font-size:12.5px;margin-top:2px}
  .claims{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}
  .claim{font-size:11.5px;padding:1px 7px;border-radius:5px;border:1px solid var(--line);
    color:var(--mute);word-break:break-all}

  .req{border:1px solid var(--warn);border-radius:var(--radius);padding:11px 12px;
    margin-bottom:8px;background:var(--panel)}
  .req .head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  .req .timer{color:var(--warn);font-variant-numeric:tabular-nums;flex:none;font-size:12.5px}
  .req .timer.late{color:var(--danger)}
  .req .path{color:var(--human);word-break:break-all;display:block;margin:5px 0}
  .req .why{color:var(--mute);font-size:12.5px;margin-bottom:8px}
  .req .settle{color:var(--mute);font-size:11.5px;border-top:1px dashed var(--line);padding-top:7px}

  /* Collapsed by default: <details> is the one HTML element that gives us
     that for free, no JS state to track across a page an EventSource keeps
     re-rendering underneath the person's cursor. */
  #work[open] summary{margin-bottom:8px}
  #work summary{cursor:pointer;color:var(--mute);font-size:12.5px}
  #work summary::marker{color:var(--mute)}
  .witem{padding:7px 9px;border:1px solid var(--line);border-radius:var(--radius);
    background:var(--panel);margin-bottom:6px;font-size:12.5px}
  .witem .owner{font-weight:600}
  .witem .path{color:var(--human);word-break:break-all}

  .feed{flex:1;overflow:auto;padding:16px 20px;min-height:0;display:flex;
    flex-direction:column;gap:5px;justify-content:flex-end}
  .ev{display:flex;gap:10px;align-items:baseline;flex:none}
  .ev time{color:var(--mute);font-size:12px;flex:none;font-variant-numeric:tabular-nums}
  .ev .who{font-weight:600;flex:none}
  .ev .who.human{color:var(--human)}
  .ev.system{color:var(--mute)}
  .ev.high .body{border-left:2px solid var(--danger);padding-left:8px}
  .ev .body{word-break:break-word}

  footer{border-top:1px solid var(--line);padding:11px 20px}
  .bar{display:flex;align-items:center;gap:10px;color:var(--mute);font-size:12px}
  kbd{font:inherit;font-size:11px;border:1px solid var(--line);border-bottom-width:2px;
    border-radius:4px;padding:0 5px;color:var(--ink)}
  .composer{display:none;gap:8px}
  body.speaking .composer{display:flex}
  body.speaking .bar{display:none}
  input[type=text]{flex:1;font:inherit;padding:8px 12px;border-radius:8px;
    border:1px solid var(--line);background:var(--panel);color:var(--ink)}
  input[type=text]:focus{outline:2px solid var(--accent);outline-offset:-1px}
  button{font:inherit;font-size:12.5px;padding:7px 13px;border-radius:8px;cursor:pointer;
    border:1px solid var(--line);background:transparent;color:var(--ink)}
  button:hover{border-color:var(--mute)}
  .link{background:none;border:none;color:var(--mute);cursor:pointer;padding:0;
    text-decoration:underline;font-size:12px}
  .empty{color:var(--mute);font-style:italic}
  .who-btn{font:inherit;font-size:12px;color:var(--mute);background:none;border:none;
    border-bottom:1px dotted var(--line);cursor:pointer;padding:0 1px}
  .who-btn:hover{color:var(--human);border-bottom-color:var(--human)}
  .note{padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius);
    background:var(--panel);margin-bottom:6px;cursor:pointer}
  .note:hover{border-color:var(--human)}
  .note .t{font-size:13px}
  .note .m{color:var(--mute);font-size:11.5px;margin-top:3px}

  /* The reader. A note you cannot read in full is not a note. */
  #reader[hidden]{display:none}
  #reader{position:fixed;inset:0;background:var(--bg);z-index:20;
    display:flex;flex-direction:column}
  #reader .bar{display:flex;align-items:center;gap:12px;padding:14px 24px;
    border-bottom:1px solid var(--line)}
  #reader .doc{flex:1;overflow:auto;padding:34px 24px 60px}
  #reader .inner{max-width:74ch;margin:0 auto}
  #reader h3{font-size:20px;line-height:1.35;margin:0 0 10px;font-weight:600}
  #reader .meta{color:var(--mute);font-size:12.5px;margin-bottom:26px}
  #reader .body{white-space:pre-wrap;font-size:14.5px;line-height:1.7}
  #reader .tag{font-size:11.5px;padding:1px 7px;border-radius:5px;
    border:1px solid var(--line);color:var(--mute);margin-right:4px}
  #reader .nav{margin-left:auto;display:flex;gap:8px;align-items:center}
  #reader .count{color:var(--mute);font-size:12px}
  button:disabled{opacity:.35;cursor:default}
  /* The one control here that acts rather than speaks. Off is loud on purpose:
     a bus that will not grow when it needs to has to say so, not hide it. */
  #births.off{color:var(--danger);border-bottom-color:var(--danger)}
</style>
</head>
<body>
<header>
  <h1>parley</h1>
  <span class="mode" id="mode">&mdash;</span>
  <span class="grow"></span>
  <span class="meta" id="repo"></span>
  <button class="who-btn" id="births" title="whether parley may start more fronts &mdash; it is your money"></button>
  <button class="who-btn" id="you" title="click to change how you appear on the bus"></button>
  <span class="meta" id="conn">connecting&hellip;</span>
</header>
<main>
  <aside>
    <h2>Fronts</h2>
    <div id="fronts"><p class="empty">nobody on the bus yet</p></div>
    <h2 style="margin-top:22px">Pending permission</h2>
    <div id="requests"><p class="empty">nothing pending</p></div>
    <details id="work" style="margin-top:22px;display:none">
      <summary id="work-summary"></summary>
      <div id="work-items"></div>
    </details>
    <h2 style="margin-top:22px">Notes</h2>
    <div id="notes"><p class="empty">no notes yet</p></div>
    <p class="hint" style="padding:0">Durable knowledge the fronts left for every
       future session. <code>parley notes --export</code> writes them to
       <code>.parley/notes.md</code>, which is versioned in git.</p>
  </aside>
  <section class="feedwrap">
    <div class="feed" id="feed"></div>
    <footer>
      <div class="bar">
        <span>watching &middot; the fronts settle territory and permission among themselves</span>
        <span class="grow"></span>
        <span><kbd>s</kbd> say &middot; <kbd>n</kbd> read notes &middot; click your name to change it</span>
      </div>
      <form class="composer" id="form" autocomplete="off">
        <input type="text" id="msg" placeholder="goes out as human, at high priority &mdash; @NAME to direct it" />
        <button type="submit">Send</button>
        <button type="button" class="link" id="cancel">esc</button>
      </form>
    </footer>
  </section>
</main>

<div id="reader" hidden>
  <div class="bar">
    <button id="r-close" title="Esc">&larr; back</button>
    <span class="count" id="r-count"></span>
    <span class="nav">
      <button id="r-prev" title="left arrow">&larr; previous</button>
      <button id="r-next" title="right arrow">next &rarr;</button>
    </span>
  </div>
  <div class="doc">
    <div class="inner">
      <h3 id="r-title"></h3>
      <div class="meta" id="r-meta"></div>
      <div class="body" id="r-body"></div>
    </div>
  </div>
</div>

<script>
const TOKEN = "__TOKEN__";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const hhmm = (iso) => { const d = new Date(iso);
  return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0"); };
const mmss = (s) => Math.floor(s/60)+":"+String(s%60).padStart(2,"0");

// Speaking is a mode you enter, not a box that sits there waiting. The default
// posture is watching; a human gives an opinion now and then, and is never
// expected to.
function setSpeaking(on) {
  document.body.classList.toggle("speaking", on);
  if (on) $("msg").focus(); else $("msg").blur();
}
document.addEventListener("keydown", (e) => {
  const speaking = document.body.classList.contains("speaking");
  if (reading !== null) {
    if (e.key === "Escape") { closeNote(); }
    else if (e.key === "ArrowLeft" || e.key === "k") { if (reading > 0) openNote(reading - 1); }
    else if (e.key === "ArrowRight" || e.key === "j") { if (reading < allNotes.length - 1) openNote(reading + 1); }
    return;
  }
  if (!speaking && (e.key === "s" || e.key === "S") && !e.metaKey && !e.ctrlKey) {
    e.preventDefault(); setSpeaking(true);
  } else if (!speaking && (e.key === "n" || e.key === "N") && !e.metaKey && !e.ctrlKey) {
    e.preventDefault(); openNote(0);
  } else if (!speaking && (e.key === "w" || e.key === "W") && !e.metaKey && !e.ctrlKey) {
    e.preventDefault(); $("work").open = !$("work").open;
  } else if (!speaking && (e.key === "b" || e.key === "B") && !e.metaKey && !e.ctrlKey) {
    // The same key the terminal panel answers to.
    e.preventDefault(); $("births").click();
  } else if (e.key === "Escape") {
    setSpeaking(false);
  }
});
$("cancel").addEventListener("click", () => setSpeaking(false));

// Stopping parley spending money is a click, not a config file: the moment it
// matters is the moment somebody is watching the bill go up.
$("births").addEventListener("click", async () => {
  const off = $("births").className.indexOf("off") >= 0;
  if (!off && !window.confirm("Stop parley starting any more fronts?\n\nThe pool stays open and the fronts already here keep working.")) return;
  const r = await post("/births", { allow: off });
  if (!r.ok) window.alert("parley: " + (r.error && (r.error.code || r.error) || "could not change it"));
});

// Your name is set here, not with a command-line flag, and it is remembered.
$("you").addEventListener("click", async () => {
  const current = $("you").textContent.replace(/^you are /, "");
  const wanted = window.prompt("How should the fronts see you on this bus?", current);
  if (wanted === null) return;
  const r = await post("/rename", { name: wanted });
  if (!r.ok) window.alert("parley: " + (r.error && (r.error.code || r.error) || "could not rename"));
});

// --- the note reader ---------------------------------------------------------
let allNotes = [];
let reading = null;

function openNote(index) {
  if (!allNotes.length) return;
  reading = Math.max(0, Math.min(index, allNotes.length - 1));
  const n = allNotes[reading];
  $("r-title").textContent = n.title;
  $("r-meta").innerHTML = esc(n.authorName) + " &middot; " + esc(new Date(n.at).toLocaleString())
    + (n.tags && n.tags.length ? "<br><br>" + n.tags.map((t) => '<span class="tag">'+esc(t)+'</span>').join("") : "");
  $("r-body").textContent = n.body || "(no body)";
  $("r-count").textContent = (reading + 1) + " of " + allNotes.length;
  $("r-prev").disabled = reading === 0;
  $("r-next").disabled = reading === allNotes.length - 1;
  $("reader").hidden = false;
}
function closeNote() { reading = null; $("reader").hidden = true; }

document.addEventListener("click", (ev) => {
  const card = ev.target.closest("[data-note]");
  if (card) openNote(Number(card.dataset.note));
});
$("r-close").addEventListener("click", closeNote);
$("r-prev").addEventListener("click", () => openNote(reading - 1));
$("r-next").addEventListener("click", () => openNote(reading + 1));

let atBottom = true;
$("feed").addEventListener("scroll", () => {
  const el = $("feed");
  atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
});

// Grouped by owner, not by item — the page is something a person glances at,
// and listing every one of thirteen offered items is the corpus this whole
// feature exists to avoid putting in front of them. The itemised list only
// shows once they open the <details> themselves.
function workOwnerName(id, fronts) {
  if (!id) return "pool";
  const f = (fronts || []).find((x) => x.id === id);
  return f ? f.name : id;
}
function workGroupsFrom(work, fronts) {
  const byOffered = new Map(), byTaken = new Map();
  let open = 0;
  for (const w of work) {
    if (w.state === "offered" && w.offeredToId) byOffered.set(w.offeredToId, (byOffered.get(w.offeredToId) || 0) + 1);
    else if (w.state === "taken" && w.takenById) byTaken.set(w.takenById, (byTaken.get(w.takenById) || 0) + 1);
    else if (w.state === "open") open++;
  }
  const groups = [];
  for (const [id, count] of byOffered) groups.push({ label: workOwnerName(id, fronts), count, kind: "offered" });
  for (const [id, count] of byTaken) groups.push({ label: workOwnerName(id, fronts), count, kind: "taken" });
  if (open > 0) groups.push({ label: "pool", count: open, kind: "open" });
  return groups;
}

function render(s) {
  $("mode").textContent = s.mode;
  $("mode").className = "mode " + s.mode;
  $("repo").textContent = s.repo.split("/").pop();
  $("you").textContent = "you are " + s.you;

  // §4.7: a human here has a voice and not a vote, except on spending. The
  // label says what the switch is switching, not just that it exists.
  var b = s.births || { allowed: true, max: 6, live: 0 };
  $("births").textContent = (b.allowed ? "fronts " : "births off \u00b7 ") + b.live + "/" + b.max;
  $("births").className = "who-btn" + (b.allowed ? "" : " off");

  allNotes = (s.notes || []).slice().reverse();
  $("notes").innerHTML = allNotes.length ? allNotes.map((n, i) =>
    '<div class="note" data-note="'+i+'" tabindex="0" role="button"><div class="t">'+esc(n.title)+'</div>'
    + '<div class="m">'+esc(n.authorName)+(n.tags && n.tags.length ? ' &middot; '+esc(n.tags.join(", ")) : '')+'</div>'
    + '</div>'
  ).join("") : '<p class="empty">no notes yet</p>';
  if (reading !== null) openNote(reading);

  $("fronts").innerHTML = s.fronts.length ? s.fronts.map((f) => {
    const cls = f.connected ? "live" : (f.idle_s > 240 ? "stale" : "");
    const claims = (f.claims || []).map((c) => '<span class="claim">'+esc(c)+'</span>').join("");
    return '<div class="front"><div class="top"><span class="dot '+cls+'"></span>'
      + '<span class="name">'+esc(f.name)+'</span>'
      + '<span class="grow"></span><span class="meta">'+esc(f.harness)+' &middot; '+f.idle_s+'s</span></div>'
      + '<div class="mission">'+esc(f.mission || "no mission declared")+'</div>'
      + (claims ? '<div class="claims">'+claims+'</div>' : '')
      + '</div>';
  }).join("") : '<p class="empty">nobody else on the bus yet</p>';

  $("requests").innerHTML = s.requests.length ? s.requests.map((r) =>
    '<div class="req"><div class="head"><strong>'+esc(r.requester)+'</strong>'
    + '<span class="timer'+(r.seconds_left<60?' late':'')+'">'+mmss(r.seconds_left)+' left</span></div>'
    + '<span class="path">'+esc(r.path)+'</span>'
    + '<div class="meta">from <strong>'+esc(r.owner)+'</strong></div>'
    + '<div class="why">'+esc(r.reason || "no reason given")+'</div>'
    + '<div class="settle">'+esc(r.owner)+' settles this. Unanswered, it is granted to '
    + esc(r.requester)+' and announced.</div></div>'
  ).join("") : '<p class="empty">nothing pending</p>';

  const liveWork = (s.work || []).filter((w) => w.state !== "done");
  $("work").style.display = liveWork.length ? "" : "none";
  if (liveWork.length) {
    const groups = workGroupsFrom(liveWork, s.fronts);
    $("work-summary").textContent = "Work (" + liveWork.length + ")  ·  "
      + groups.map((g) => g.label + " " + g.count + " " + g.kind).join("    ");
    $("work-items").innerHTML = liveWork.map((w) => {
      const owner = w.state === "offered" ? workOwnerName(w.offeredToId, s.fronts)
        : w.state === "taken" ? workOwnerName(w.takenById, s.fronts) : "pool";
      return '<div class="witem"><span class="owner">'+esc(owner)+'</span> &middot; '+esc(w.state)
        + '<div class="path">'+esc(w.paths[0])+'</div><div class="meta">'+esc(w.title)+'</div></div>';
    }).join("");
  }

  $("feed").innerHTML = s.feed.map((e) => {
    const t = '<time>'+hhmm(e.at)+'</time>';
    if (e.kind === "system" || !e.from)
      return '<div class="ev system">'+t+'<span class="body">&middot; '+esc(e.text)+'</span></div>';
    const who = '<span class="who'+(e.from.kind==="human"?" human":"")+'">'+esc(e.from.name)+'</span>';
    const to = e.to ? '<span class="meta">&rsaquo;'+esc(e.to)+'</span> ' : '';
    return '<div class="ev'+(e.priority==="high"?" high":"")+'">'+t+who
      +'<span class="body">'+to+esc(e.text)+'</span></div>';
  }).join("");
  if (atBottom) $("feed").scrollTop = $("feed").scrollHeight;
}

async function post(path, body) {
  return fetch(path + "?t=" + TOKEN, {
    method: "POST",
    headers: { "content-type": "application/json", "x-parley-token": TOKEN },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ ok: false }));
}

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = $("msg").value.trim();
  if (!text) return;
  $("msg").value = "";
  const m = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  await post("/say", m ? { to: m[1], text: m[2] } : { text: text });
  setSpeaking(false);
});

const es = new EventSource("/events?t=" + TOKEN);
es.onopen = () => { $("conn").textContent = "live"; $("conn").className = "meta live"; };
es.onerror = () => { $("conn").textContent = "reconnecting"; $("conn").className = "meta down"; };
es.onmessage = (e) => {
  $("conn").textContent = "live"; $("conn").className = "meta live";
  render(JSON.parse(e.data));
};
</script>
</body>
</html>`;
