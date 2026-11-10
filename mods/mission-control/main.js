// Mission Control: the on-call operator's watchers and their triage tasks.
// Reads <state>/board.json, written by the `oncall-mc` CLI. `oncall-mc` opens it as a pane beside the
// operator in the "Mission Control" space, with props { state: <state folder> }.
// Clicking a watcher or a task peeks its terminal (keep it as a tab from the peek bar).
//
// Look: a dispatch board. What needs you sits in a tinted strip on top; live watchers are rows with a
// status rail; tasks hang under them with their status as a colored word. Only theme colors are used.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, agents, theme, run, exec, notify, props, home, readTextFile, watchFolder, window } from "herdr";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ACTIVE = new Set(["queued", "triaging", "waiting", "needs-you"]);
const DAY = 86400;

const WATCHER_FILTERS = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "issues", label: "Issues" },
  { id: "stopped", label: "Stopped" },
];
const TASK_FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "open", label: "Open", test: (x) => ACTIVE.has(x.status) },
  { id: "needs-you", label: "Needs you", test: (x) => x.status === "needs-you" },
  { id: "triaging", label: "Triaging", test: (x) => x.status === "triaging" },
  { id: "queued", label: "Queued", test: (x) => x.status === "queued" },
  { id: "done", label: "Done", test: (x) => x.status === "done" },
  { id: "failed", label: "Failed", test: (x) => x.status === "failed" },
];

// Type scale (px): name, body, meta.
const NAME = 13.5;
const BODY = 12.5;
const META = 11.5;
const STATUS_W = 82; // the status word column, so task titles line up

function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < DAY) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / DAY)}d`;
}

function every(sec) {
  return sec >= 120 && sec % 60 === 0 ? `every ${sec / 60}m` : `every ${sec}s`;
}

const num = (n) => (n ?? 0).toLocaleString("en-US");

function prLabel(url) {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? `PR #${m[1]}` : "PR";
}

function linkLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return "link";
  }
}

// "Wed Nov 4, 10:30 PM" (built by hand: this runtime ignores toLocaleString options).
function shortDate(d) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = d.getHours() % 12 || 12;
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}, ${h}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

// Opens a URL with the platform's handler.
function openUrl(url) {
  const platform = window()?.platform;
  if (platform === "macos") exec("open", [url]);
  else if (platform === "windows") exec("cmd", ["/c", "start", "", url]);
  else exec("xdg-open", [url]);
}

// A theme color at low strength, for the attention strip.
const tint = (hex, alpha) => (/^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : hex);

export default class MissionControl extends View {
  init(_props, cx) {
    this.dir = props()?.state ?? `${home()}/mission-control/state`;
    this.board = null;
    this.error = null;
    this.showOld = new Set();
    this.showStopped = false;
    this.briefing = {}; // id -> when "Brief me" was clicked
    this.watcherFilter = localStorage.getItem("watcherFilter") ?? "all";
    this.taskFilter = localStorage.getItem("taskFilter") ?? "all";
    this.seenAttention = new Set(JSON.parse(localStorage.getItem("seenAttention") ?? "[]"));
    this.load(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(this.dir);
        } catch {
          return;
        }
        await this.load(cx);
      }
    });
    // Relative times and stale detection only.
    cx.timer.every(30000, (cx) => this.load(cx));
  }

  async load(cx) {
    try {
      const text = await readTextFile(`${this.dir}/board.json`);
      this.board = text ? JSON.parse(text) : null;
      this.error = null;
    } catch (e) {
      this.error = String(e);
    }
    this.announce();
    cx.notify();
  }

  // A toast for each newly flagged task or watcher.
  announce() {
    if (!this.board) return;
    const flagged = [...this.board.tasks.filter((x) => x.status === "needs-you"), ...this.board.watchers].filter((x) => x.attention);
    let dirty = false;
    for (const x of flagged) {
      const key = `${x.id}@${x.attention.at}`;
      if (this.seenAttention.has(key)) continue;
      this.seenAttention.add(key);
      dirty = true;
      const addr = x.worker?.address ?? x.address;
      notify({
        title: `Needs you: ${x.title ?? x.channel ?? x.id}`,
        body: x.attention.message,
        level: "warning",
        timeout: 0,
        action: addr ? { name: "terminal.peek", args: { terminal: addr } } : undefined,
      });
    }
    if (dirty) localStorage.setItem("seenAttention", JSON.stringify([...this.seenAttention].slice(-200)));
  }

  // Live status of a terminal: working | blocked | done | idle | error | exited | null.
  status(addr) {
    if (!addr) return null;
    const a = agents().find((x) => x.address === addr);
    if (a) return a.status;
    const k = terminals().find((x) => x.address === addr);
    if (!k || k.state !== "live") return "exited";
    return k.status ?? "idle";
  }

  open(addr) {
    if (!addr) return;
    if (this.status(addr) === "exited") {
      notify({ title: "That agent has exited", body: `${addr} is no longer running. Run oncall-mc resume to restart it.`, level: "warning" });
      return;
    }
    run("terminal.peek", { terminal: addr });
  }

  // "Brief me": asks the operator to catch the person up on this item, then shows the operator.
  briefMe(id, cx) {
    this.askOperator(id, ["brief", id], `Could not ask for a brief on ${id}`, cx);
  }

  // Runs an oncall-mc command that messages the operator, then shows the operator pane.
  askOperator(key, args, failTitle, cx) {
    this.briefing[key] = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      const mc = this.dir.replace(/\/state\/?$/, "") + "/bin/oncall-mc";
      let r;
      try {
        r = await exec(mc, args);
      } catch (e) {
        r = { code: 1, stdout: "", stderr: String(e) };
      }
      if (r.code === 0) {
        const op = this.board?.operator?.address;
        if (op) run("pane.focus", { terminal: op });
      } else {
        delete this.briefing[key];
        let msg = r.stderr || r.stdout;
        try { msg = JSON.parse(r.stdout).error ?? msg; } catch {}
        notify({ title: failTitle, body: msg.trim().slice(0, 300), level: "error" });
      }
      cx.notify();
    });
  }

  briefButton(t, id, onTint, color = t.blocked) {
    const asked = this.briefing[id] && Date.now() - this.briefing[id] < 60000;
    return div()
      .id(`brief-${id}`)
      .flex_none()
      .px(9)
      .py(3)
      .rounded(6)
      .text_size(META)
      .font_medium()
      .cursor_pointer()
      .bg(onTint ? tint(color, "33") : "#00000000")
      .border(1)
      .border_color(tint(color, asked ? "44" : "88"))
      .text_color(asked ? t.muted : t.foreground)
      .hover((el) => el.bg(tint(color, "4d")))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.briefMe(id, cx);
      })
      .child(asked ? "Briefing in operator" : "Brief me");
  }

  // The recorded status can lag: a waiting or queued task whose worker is busy is really triaging.
  effective(task) {
    const working = this.status(task.worker?.address) === "working";
    if (working && (task.status === "waiting" || task.status === "queued")) return { ...task, status: "triaging", recorded: task.status };
    return { ...task, workerActive: working && task.status !== "triaging" };
  }

  // running | issues (dead, errored, stale, flagged) | stopped
  health(w) {
    if (w.status === "stopped") return "stopped";
    const st = this.status(w.address);
    return st === "exited" || st === "error" || st === "blocked" || this.stale(w) || w.stats?.last_error || w.attention ? "issues" : "running";
  }

  stale(w) {
    const last = w.stats?.last_check;
    return w.status !== "stopped" && last && Date.now() / 1000 - last > Math.max(3 * w.interval, 600);
  }

  // ---------- pieces ----------

  statusWord(t, status) {
    const s = {
      queued: { glyph: "◦", label: "queued", color: t.dim },
      triaging: { glyph: SPIN[0], label: "triaging", color: t.working, spin: true },
      waiting: { glyph: "◦", label: "waiting", color: t.idle },
      "needs-you": { glyph: "●", label: "needs you", color: t.blocked },
      done: { glyph: "✓", label: "done", color: t.done },
      failed: { glyph: "✕", label: "failed", color: t.blocked },
    }[status] ?? { glyph: "·", label: status, color: t.muted };
    return h_flex()
      .w(STATUS_W)
      .flex_none()
      .gap(5)
      .items_center()
      .text_size(META)
      .text_color(s.color)
      .child(div().w(10).flex_none().when(Boolean(s.spin), (el) => el.frames(SPIN, 90)).child(s.glyph))
      .child(div().child(s.label));
  }

  textLink(t, id, label, url, color) {
    return div()
      .id(id)
      .flex_none()
      .text_size(META)
      .text_color(color)
      .cursor_pointer()
      .hover((s) => s.underline().text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openUrl(url);
      })
      .child(label);
  }

  links(t, task) {
    const items = [
      ...(task.prs ?? []).map((u, i) => this.textLink(t, `pr-${task.id}-${i}`, prLabel(u), u, t.accent)),
      ...(task.links ?? []).slice(0, 3).map((u, i) => this.textLink(t, `ln-${task.id}-${i}`, linkLabel(u), u, t.muted)),
      ...(task.source ? [this.textLink(t, `src-${task.id}`, "source", task.source, t.muted)] : []),
    ];
    return items.length ? h_flex().gap(12).items_center().flex_wrap().children(items) : null;
  }

  taskRow(t, task) {
    const addr = task.worker?.address;
    const workerBlocked = ACTIVE.has(task.status) && this.status(addr) === "blocked";
    const links = this.links(t, task);
    const indent = (el) => el.pl(STATUS_W + 8);
    return v_flex()
      .id(`task-${task.id}`)
      .px(8)
      .py(5)
      .gap(2)
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.open(addr))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(this.statusWord(t, task.status))
          .child(div().flex_1().min_w_0().truncate().text_size(BODY).text_color(t.foreground).child(task.title))
          .when(task.status === "needs-you", (el) => el.child(this.briefButton(t, task.id, false)))
          .when(Boolean(task.workerActive), (el) =>
            el.child(h_flex().flex_none().gap(4).text_size(META).text_color(t.working)
              .child(div().frames(SPIN, 90).child(SPIN[0])).child(div().child("worker active"))))
          .child(div().flex_none().text_size(META).text_color(t.dim).child(ago(task.updated_at))),
      )
      // Second line: the task ID in the status column (the operator refers to tasks by ID), then the summary.
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().w(STATUS_W).flex_none().pl(15).text_size(META).text_color(t.dim).child(task.id))
          .when(Boolean(task.summary), (el) =>
            el.child(div().flex_1().min_w_0().truncate().text_size(META + 0.5).text_color(t.muted).child(task.summary)),
          ),
      )
      .when(Boolean((task.fyis ?? (task.fyi ? [task.fyi] : [])).length), (el) => {
        const fyis = task.fyis ?? [task.fyi];
        const last = fyis[fyis.length - 1];
        return el.child(indent(div().truncate().text_size(META).text_color(t.accent)
          .child(`FYI ${ago(last.at)} ago: ${last.message}${fyis.length > 1 ? ` (+${fyis.length - 1} more)` : ""}`)));
      })
      .when(workerBlocked, (el) =>
        el.child(indent(div().text_size(META).text_color(t.blocked).child("Worker is waiting for an approval. Open it to answer."))),
      )
      .when(Boolean(links), (el) => el.child(indent(div().child(links))));
  }

  taskList(t, groupId, tasks) {
    if (this.taskFilter !== "all") {
      const test = TASK_FILTERS.find((f) => f.id === this.taskFilter)?.test ?? (() => true);
      const matches = tasks.filter(test).sort((a, b) => b.updated_at - a.updated_at);
      return v_flex()
        .children(matches.map((x) => this.taskRow(t, x)))
        .when(matches.length === 0, (el) => el.child(div().px(8).py(3).text_size(META).text_color(t.dim).child("No matching tasks")));
    }
    const active = tasks.filter((x) => ACTIVE.has(x.status));
    const finished = tasks.filter((x) => !ACTIVE.has(x.status)).sort((a, b) => b.updated_at - a.updated_at);
    const showAll = this.showOld.has(groupId);
    const recent = showAll ? finished : finished.filter((x) => Date.now() / 1000 - x.updated_at < DAY).slice(0, 3);
    const hidden = finished.length - recent.length;
    return v_flex()
      .children(active.map((x) => this.taskRow(t, x)))
      .children(recent.map((x) => this.taskRow(t, x)))
      .when(hidden > 0 || (showAll && finished.length > 3), (el) =>
        el.child(
          div()
            .id(`more-${groupId}`)
            .px(8)
            .py(3)
            .text_size(META)
            .text_color(t.dim)
            .cursor_pointer()
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => {
              showAll ? this.showOld.delete(groupId) : this.showOld.add(groupId);
              cx.notify();
            })
            .child(showAll ? "Show fewer" : `Show ${hidden} older`),
        ),
      );
  }

  // A row with a status rail down its left edge.
  railed(t, color, body) {
    return h_flex()
      .items_start()
      .gap(10)
      .py(10)
      .px(12)
      .border_b(1)
      .border_color(t.border)
      .child(div().w(3).flex_none().self_stretch().rounded(2).bg(color))
      .child(body.flex_1().min_w_0());
  }

  watcherRow(t, w, tasks) {
    const health = this.health(w);
    const st = this.status(w.address);
    const s = w.stats ?? {};
    const stale = this.stale(w);
    const rail = health === "issues" ? t.blocked : health === "stopped" ? t.border : st === "working" ? t.working : t.idle;
    const stats = [`${num(s.checks)} checks`, `${num(s.seen)} messages`, `${num(s.matched)} matched`, every(w.interval)];
    if (w.mode) stats.push(`mode ${w.mode}`);
    if (w.agent?.model || w.agent?.effort) stats.push([w.agent.model, w.agent.effort].filter(Boolean).join(" "));
    const head = v_flex()
      .id(`watcher-${w.id}`)
      .gap(3)
      .px(6)
      .py(3)
      .mx(-6)
      .rounded(6)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click(() => this.open(w.address))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .flex_1()
              .min_w_0()
              .truncate()
              .font_medium()
              .text_size(NAME)
              .text_color(health === "stopped" ? t.muted : t.foreground)
              .child(w.channel),
          )
          .when(st === "working", (el) => el.child(div().flex_none().text_size(META).text_color(t.working).frames(SPIN, 90).child(SPIN[0])))
          .child(
            div()
              .flex_none()
              .text_size(META)
              .text_color(stale ? t.blocked : t.dim)
              .child(health === "stopped" ? "stopped" : s.last_check ? `checked ${ago(s.last_check)} ago` : "starting"),
          ),
      )
      .child(div().truncate().text_size(META + 0.5).text_color(t.muted).child(w.goal))
      .child(h_flex().gap(12).flex_wrap().text_size(META).text_color(t.dim).children(stats.map((x) => div().child(x))))
      .when(Boolean(s.last_error), (el) => el.child(div().truncate().text_size(META).text_color(t.blocked).child(s.last_error)))
      .when(Boolean(stale), (el) => el.child(div().text_size(META).text_color(t.blocked).child("No check-in for a while. Run oncall-mc resume if it stays quiet.")))
      .when(Boolean(w.watchdog?.length) && Date.now() / 1000 - w.watchdog[w.watchdog.length - 1].at < DAY, (el) => {
        const last = w.watchdog[w.watchdog.length - 1];
        return el.child(div().truncate().text_size(META).text_color(t.working)
          .child(`Watchdog restarted a hung turn ${ago(last.at)} ago (stuck ${Math.round(last.stuck_s / 60)} min)`));
      })
      .when(st === "exited" && health !== "stopped", (el) => el.child(div().text_size(META).text_color(t.blocked).child("Watcher has exited. Run oncall-mc resume.")));
    const list = this.taskList(t, w.id, tasks);
    return this.railed(t, rail, v_flex().gap(4).child(head).child(div().mx(-8).child(list)));
  }

  operatorRow(t, b, direct) {
    const st = this.status(b.operator?.address);
    const word = { working: "working", blocked: "needs you", done: "replied", idle: "idle", exited: "not running" }[st] ?? "";
    const head = h_flex()
      .id("operator-direct")
      .gap(8)
      .px(6)
      .py(3)
      .mx(-6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.open(b.operator?.address))
      .child(div().flex_1().font_medium().text_size(NAME).text_color(t.foreground).child("Operator"))
      .when(st === "working", (el) => el.child(div().text_size(META).text_color(t.working).frames(SPIN, 90).child(SPIN[0])))
      .child(div().text_size(META).text_color(st === "blocked" || st === "exited" ? t.blocked : t.dim).child(word));
    const body = v_flex()
      .gap(4)
      .child(head)
      .when(direct.length > 0, (el) => el.child(div().mx(-8).child(this.taskList(t, "operator", direct))))
      .when(direct.length === 0, (el) => el.child(div().text_size(META).text_color(t.dim).child("Direct tasks you give the operator show here.")));
    return this.railed(t, st === "blocked" || st === "exited" ? t.blocked : st === "working" ? t.working : t.accent, body);
  }

  // Unacked FYIs: below the red strip, in the calmer accent color, until the person says "Got it".
  fyiStrip(t, b) {
    const watcherName = (id) => (id === "operator" ? "operator" : b.watchers.find((w) => w.id === id)?.channel ?? id);
    const items = b.tasks.filter((x) => x.status !== "needs-you")
      .map((x) => ({ x, fyis: x.fyis ?? (x.fyi ? [x.fyi] : []) })).filter((e) => e.fyis.length)
      .sort((p, q) => q.fyis[q.fyis.length - 1].at - p.fyis[p.fyis.length - 1].at);
    if (!items.length) return null;
    return v_flex()
      .flex_none()
      .mx(8)
      .mt(8)
      .p(4)
      .rounded(8)
      .bg(tint(t.accent, "14"))
      .border(1)
      .border_color(tint(t.accent, "44"))
      .child(div().px(8).pt(4).pb(2).text_size(META).font_medium().text_color(t.accent).child(items.length === 1 ? "FYI" : `FYI (${items.length})`))
      .children(items.map(({ x, fyis }) => {
        const last = fyis[fyis.length - 1];
        const acking = this.briefing[`fyi-${x.id}`];
        return h_flex()
          .id(`fyi-${x.id}`)
          .px(8)
          .py(5)
          .gap(10)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover((el) => el.bg(tint(t.accent, "22")))
          .on_click(() => this.open(x.worker?.address))
          .child(
            v_flex().flex_1().min_w_0().gap(1)
              .child(div().truncate().text_size(BODY).font_medium().text_color(t.foreground).child(x.title))
              .child(div().truncate().text_size(META + 0.5).text_color(t.muted).child(last.message))
              .child(div().truncate().text_size(META).text_color(t.dim)
                .child(`${x.id} in ${watcherName(x.watcher)}, ${ago(last.at)} ago${fyis.length > 1 ? `, ${fyis.length} FYIs` : ""}`)),
          )
          .child(this.briefButton(t, x.id, false, t.accent))
          .child(
            div()
              .id(`fyi-ack-${x.id}`)
              .flex_none()
              .px(9)
              .py(3)
              .rounded(6)
              .text_size(META)
              .font_medium()
              .cursor_pointer()
              .border(1)
              .border_color(tint(t.accent, "77"))
              .text_color(acking ? t.muted : t.foreground)
              .hover((el) => el.bg(tint(t.accent, "33")))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.ackFyi(x.id, cx);
              })
              .child(acking ? "Clearing" : "Got it"),
          );
      }));
  }

  ackFyi(id, cx) {
    const key = `fyi-${id}`;
    this.briefing[key] = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      const mc = this.dir.replace(/\/state\/?$/, "") + "/bin/oncall-mc";
      let r;
      try {
        r = await exec(mc, ["ack", id, "--fyi"]);
      } catch (e) {
        r = { code: 1, stdout: "", stderr: String(e) };
      }
      delete this.briefing[key];
      if (r.code !== 0) notify({ title: `Could not clear the FYI on ${id}`, body: (r.stderr || r.stdout).trim().slice(0, 300), level: "error" });
      await this.load(cx);
    });
  }

  // The one loud element: everything waiting on the person.
  attentionStrip(t, b) {
    const watcherName = (id) => (id === "operator" ? "operator" : b.watchers.find((w) => w.id === id)?.channel ?? id);
    const items = [
      ...b.tasks
        .filter((x) => x.status === "needs-you")
        .map((x) => ({ id: x.id, title: x.title, message: x.attention?.message ?? x.summary,
                       kind: { review: "Ready for review", decision: "Decision needed" }[x.attention?.need] ?? "Needs your input",
                       updates: [...(x.attention?.updates ?? []), ...(x.fyis ?? (x.fyi ? [x.fyi] : []))].sort((p, q) => p.at - q.at),
                       where: `${x.id} in ${watcherName(x.watcher)}`, addr: x.worker?.address })),
      ...b.watchers
        .filter((w) => w.attention)
        .map((w) => ({ id: w.id, title: w.channel, message: w.attention.message, kind: "Watcher needs you", where: "watcher", addr: w.address })),
    ];
    if (!items.length) return null;
    return v_flex()
      .flex_none()
      .mx(8)
      .mt(8)
      .p(4)
      .rounded(8)
      .bg(tint(t.blocked, "1a"))
      .border(1)
      .border_color(tint(t.blocked, "55"))
      .child(div().px(8).pt(4).pb(2).text_size(META).font_medium().text_color(t.blocked).child(items.length === 1 ? "Needs you" : `Needs you (${items.length})`))
      .children(
        items.map((x) =>
          h_flex()
            .id(`attn-${x.id}`)
            .px(8)
            .py(5)
            .gap(10)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(tint(t.blocked, "26")))
            .on_click(() => this.open(x.addr))
            .child(
              v_flex()
                .flex_1()
                .min_w_0()
                .gap(1)
                .child(div().truncate().text_size(BODY).font_medium().text_color(t.foreground).child(x.title))
                .when(Boolean(x.message), (el) => el.child(div().truncate().text_size(META + 0.5).text_color(t.muted).child(x.message)))
                .when(Boolean(x.updates?.length), (el) => {
                  const last = x.updates[x.updates.length - 1];
                  return el.child(div().truncate().text_size(META).text_color(t.accent)
                    .child(`+${x.updates.length} update${x.updates.length > 1 ? "s" : ""}, latest ${ago(last.at)} ago: ${last.message}`));
                })
                .child(h_flex().gap(8).text_size(META)
              .child(div().flex_none().font_medium().text_color(t.blocked).child(x.kind))
              .child(div().truncate().text_color(t.dim).child(x.where))),
            )
            .child(this.briefButton(t, x.id, true)),
        ),
      );
  }

  tabs(t, title, filters, current, counts, set) {
    return h_flex()
      .gap(12)
      .items_end()
      .h(24)
      .child(div().w(62).flex_none().pb(4).text_size(META).text_color(t.dim).child(title))
      .children(
        filters.map((f) => {
          const on = f.id === current;
          const n = counts[f.id] ?? 0;
          return h_flex()
            .id(`tab-${title}-${f.id}`)
            .gap(4)
            .pb(3)
            .border_b(2)
            .border_color(on ? t.accent : "#00000000")
            .text_size(META + 0.5)
            .cursor_pointer()
            .text_color(on ? t.foreground : f.id !== "all" && n === 0 ? t.dim : t.muted)
            .hover((el) => el.text_color(t.foreground))
            .on_click((_e, cx) => {
              set(f.id);
              cx.notify();
            })
            .child(div().child(f.label))
            .when(f.id !== "all", (el) => el.child(div().text_color(on ? t.muted : t.dim).child(String(n))));
        }),
      );
  }

  filterBar(t, b) {
    const wc = {};
    for (const w of b.watchers) wc[this.health(w)] = (wc[this.health(w)] ?? 0) + 1;
    const tc = Object.fromEntries(TASK_FILTERS.map((f) => [f.id, b.tasks.filter(f.test).length]));
    return v_flex()
      .flex_none()
      .px(14)
      .pb(4)
      .border_b(1)
      .border_color(t.border)
      .child(this.tabs(t, "Watchers", WATCHER_FILTERS, this.watcherFilter, wc, (id) => {
        this.watcherFilter = id;
        localStorage.setItem("watcherFilter", id);
      }))
      .child(this.tabs(t, "Tasks", TASK_FILTERS, this.taskFilter, tc, (id) => {
        this.taskFilter = id;
        localStorage.setItem("taskFilter", id);
      }));
  }

  header(t, b) {
    const live = b ? b.watchers.filter((w) => w.status !== "stopped").length : 0;
    const open = b ? b.tasks.filter((x) => ACTIVE.has(x.status)).length : 0;
    const triaging = b ? b.tasks.filter((x) => x.status === "triaging").length : 0;
    return h_flex()
      .flex_none()
      .px(14)
      .pt(12)
      .pb(8)
      .items_center()
      .gap(14)
      .child(div().flex_1().font_semibold().text_size(15).text_color(t.foreground).child("Mission Control"))
      .when(Boolean(b), (el) =>
        el
          .when(triaging > 0, (e) => e.child(div().text_size(META).text_color(t.working).child(`${triaging} triaging`)))
          .child(div().text_size(META).text_color(t.muted).child(`${open} open`))
          .child(div().text_size(META).text_color(t.muted).child(`${live} watching`)),
      );
  }

  // Pinned under the list: the shift's context and its end-of-shift action.
  footer(t, b) {
    const s = b.session;
    const started = s?.started_at ? new Date(s.started_at * 1000) : null;
    const when = started
      ? `Shift started ${shortDate(started)}, ${ago(s.started_at)} ago`
      : "No session";
    const asked = this.briefing["__summary"] && Date.now() - this.briefing["__summary"] < 120000;
    return h_flex()
      .flex_none()
      .px(14)
      .py(8)
      .gap(10)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .child(div().flex_1().min_w_0().truncate().text_size(META).text_color(t.dim).child(s?.name ? `${s.name}. ${when}` : when))
      .child(
        div()
          .id("summarize-shift")
          .flex_none()
          .px(9)
          .py(3)
          .rounded(6)
          .border(1)
          .border_color(t.border)
          .text_size(META)
          .text_color(asked ? t.muted : t.foreground)
          .cursor_pointer()
          .hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => this.askOperator("__summary", ["summary"], "Could not start the shift summary", cx))
          .child(asked ? "Summary in operator" : "Summarize shift"),
      );
  }

  stoppedFold(t, stopped, byWatcher) {
    if (!stopped.length) return null;
    return v_flex()
      .px(12)
      .py(8)
      .child(
        div()
          .id("stopped-fold")
          .px(6)
          .py(3)
          .text_size(META)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.showStopped = !this.showStopped;
            cx.notify();
          })
          .child(this.showStopped ? `Hide stopped watchers` : `${stopped.length} stopped ${stopped.length === 1 ? "watcher" : "watchers"}`),
      )
      .when(this.showStopped, (el) =>
        el.children(
          stopped.map((w) =>
            h_flex()
              .id(`stopped-${w.id}`)
              .px(6)
              .py(3)
              .gap(8)
              .rounded(6)
              .text_size(META)
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover))
              .child(div().flex_1().min_w_0().truncate().child(w.channel))
              .child(div().flex_none().child(`${byWatcher(w.id).length} tasks`))
              .child(div().flex_none().child(w.stopped_at ? `stopped ${ago(w.stopped_at)} ago` : "stopped")),
          ),
        ),
      );
  }

  render() {
    const t = theme();
    const b = this.board ? { ...this.board, tasks: this.board.tasks.map((x) => this.effective(x)) } : null;

    if (!b) {
      return v_flex()
        .size_full()
        .child(this.header(t, null))
        .child(
          v_flex()
            .px(14)
            .py(8)
            .gap(6)
            .text_size(BODY)
            .text_color(t.muted)
            .child(this.error ? `Could not read the board: ${this.error}` : "No session yet.")
            .child("Run oncall-mc start, then ask the operator to create a watcher."),
        );
    }

    const byWatcher = (id) => b.tasks.filter((x) => x.watcher === id);
    const taskTest = TASK_FILTERS.find((f) => f.id === this.taskFilter)?.test ?? (() => true);
    const filtering = this.taskFilter !== "all";
    const direct = byWatcher("operator");
    const shown = b.watchers
      .filter((w) => this.watcherFilter === "all" || this.health(w) === this.watcherFilter)
      .filter((w) => !filtering || byWatcher(w.id).some(taskTest));
    // Stopped watchers fold away unless someone asked for them.
    const foldStopped = this.watcherFilter === "all" && !filtering;
    const rows = foldStopped ? shown.filter((w) => w.status !== "stopped") : shown;
    const stopped = foldStopped ? shown.filter((w) => w.status === "stopped") : [];
    const empty = b.watchers.length === 0;
    const strip = this.attentionStrip(t, b);
    const fyiStrip = this.fyiStrip(t, b);

    return v_flex()
      .size_full()
      .child(this.header(t, b))
      .child(this.filterBar(t, b))
      .child(
        v_flex()
          .id("mc-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .when(Boolean(strip), (el) => el.child(strip))
          .when(Boolean(fyiStrip), (el) => el.child(fyiStrip))
          // Pinned: the operator and its direct tasks come first, whatever the watcher filter.
          .child(this.operatorRow(t, b, direct))
          .when(empty, (el) =>
            el.child(
              div()
                .px(14)
                .py(10)
                .text_size(BODY)
                .text_color(t.muted)
                .child('No watchers yet. Ask the operator, for example: "create a watcher for #alerts for pages assigned to me".'),
            ),
          )
          .when(!empty && rows.length === 0 && stopped.length === 0, (el) =>
            el.child(div().px(14).py(10).text_size(BODY).text_color(t.muted).child("No watchers match these filters.")),
          )
          .children(rows.map((w) => this.watcherRow(t, w, byWatcher(w.id))))
          .when(stopped.length > 0, (el) => el.child(this.stoppedFold(t, stopped, byWatcher))),
      )
      .child(this.footer(t, b));
  }
}
