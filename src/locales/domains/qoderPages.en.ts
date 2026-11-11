/** 文案域：Qoder 产品线 · 页面（英文）。键与 `qoderPages.zh.ts` 一一对应。 */
export const en = {
  "qoder.page.accounts.title": "Accounts",
  // The page-head subtitle uses the shared `pageHead.accounts` formula
  // ("{scope} · {n} accounts · {m} need attention") — same as WB / Trae.

  "qoder.page.accounts.sectionAria": "Qoder account list ({count} accounts)",
  "qoder.page.accounts.loadFailed": "Failed to load the account list",
  "qoder.page.accounts.recheck": "Check again",

  "qoder.page.accounts.empty.title": "No Qoder account in this realm yet",
  "qoder.page.accounts.empty.description":
    "Import from a signed-in Qoder client on this machine, or paste a PAT.",
  "qoder.page.accounts.empty.action": "Add account",
  "qoder.page.accounts.empty.sources": "Sources on this machine",

  "qoder.page.accounts.import.description":
    "Read-only probe of the desktop app and CLI sessions. No client file is modified.",
  "qoder.page.accounts.import.result": "{imported} added, {updated} updated",
  "qoder.page.accounts.import.none": "Neither source has an importable account",
  "qoder.page.accounts.addDrawer.notInstalled":
    "Neither source was detected. Sign in with the official client first, or paste a PAT directly.",

  "qoder.page.accounts.source.desktop": "Qoder desktop",
  "qoder.page.accounts.source.cli": "Qoder CLI",
  "qoder.page.accounts.source.missing": "Not found",
  "qoder.page.accounts.source.unreadable": "Unreadable",
  "qoder.page.accounts.source.empty": "No account inside",
  "qoder.page.accounts.source.ready": "Importable",

  "qoder.page.accounts.pat.title": "Paste a PAT",
  "qoder.page.accounts.pat.description":
    "Personal access token (starts with pt-). For machines without a client, or when the client session cannot be read.",
  "qoder.page.accounts.pat.placeholder": "pt-…",
  "qoder.page.accounts.pat.action": "Import",
  "qoder.page.accounts.pat.invalid": "Wrong prefix: a PAT starts with pt-",
  "qoder.page.accounts.pat.cancel": "Cancel",

  // ---- Card / table / toolbar (slots of `accountCard` / `tableView` / `viewAccounts`) ----
  "qoder.page.accounts.chip.ok": "Credential usable",
  "qoder.page.accounts.chip.noCredential": "No usable credential",
  "qoder.page.accounts.chip.unrecognized": "Credential unrecognized",
  "qoder.page.accounts.chip.foreign": "Wrong realm",
  "qoder.page.accounts.chip.foreignTip":
    "This account's domain does not belong to the current realm (possibly imported by mistake)",

  // 2026-10-28 (parity): these now match WB / Trae's card wording — they used to read
  // "More actions for {name}" / "Select {name}", a third phrasing across the three cards.
  "qoder.page.accounts.card.manageAria": "Manage account {name}",
  "qoder.page.accounts.card.moreActions": "More account actions",
  "qoder.page.accounts.card.viewDetail": "View details",
  "qoder.page.accounts.card.editRemark": "Edit remark",
  "qoder.page.accounts.card.deleteAccount": "Delete account",
  "qoder.page.accounts.card.selectAria": "Select account {name}",

  "qoder.page.accounts.toolbar.sort.priority": "Credit priority",
  "qoder.page.accounts.toolbar.sort.name": "Name",
  "qoder.page.accounts.toolbar.sort.expiry": "Credential expiry",
  "qoder.page.accounts.toolbar.group.none": "No grouping",
  "qoder.page.accounts.toolbar.group.status": "By status",
  "qoder.page.accounts.toolbar.statusBucket.normal": "Normal",
  "qoder.page.accounts.toolbar.statusBucket.noCredential": "No usable credential",
  "qoder.page.accounts.toolbar.statusBucket.unrecognized": "Credential unrecognized",
  "qoder.page.accounts.quickRefreshDone": "Refreshed {n} account(s): credits · check-in status · credential status",
  "qoder.page.accounts.quickRefreshPartial": "Refreshed {n} account(s); some data did not update",
  "qoder.page.accounts.quickRefreshFail": "Refresh failed",

  "qoder.page.accounts.table.account": "Account",
  "qoder.page.accounts.table.status": "Status",
  // 2026-10-27 (T05): `expiresAt` is normalized to Unix ms by core, so the list gains a
  // Credential column (same header as WB / Trae; missing values render as "—").
  "qoder.page.accounts.table.credential": "Credential",
  "qoder.page.accounts.table.programs": "Programs",
  // 2026-10-28: the Source and Remark columns are gone — source stays in the detail
  // drawer, and the remark now lives in the Account column's identity line.

  // ---- Detail drawer (`drawerAccount`: account info + remark edited **inside the drawer**) ----
  // 2026-10-29: the drawer subtitle now comes from `shared.drawer.subtitleUid` — UID only —
  // so `qoder.page.accounts.drawer.subtitle` is gone.
  "qoder.page.accounts.drawer.info": "Account info",
  // 2026-10-27: the overview no longer repeats the credential summary / masked token
  // (the Credential tab carries them).
  // 2026-10-29: the overview gained the UID row back (user request: the overview is the
  // canonical place for account info).
  "qoder.page.accounts.drawer.domain": "Domain",
  "qoder.page.accounts.drawer.source": "Source",
  "qoder.page.accounts.drawer.addedAt": "Added at",
  "qoder.page.accounts.drawer.updatedAt": "Last updated",
  "qoder.page.accounts.drawer.credential": "Credential",
  "qoder.page.accounts.drawer.accessToken": "Access token",
  "qoder.page.accounts.drawer.refreshToken": "Refresh token",
  "qoder.page.accounts.drawer.personalToken": "Personal token",
  "qoder.page.accounts.drawer.present": "Present",
  "qoder.page.accounts.drawer.absent": "Absent",
  "qoder.page.accounts.drawer.expiresAt": "Credential expiry",

  // ---- Deletion (Qoder deletes **permanently**, no recycle bin ⇒ never claim "restorable") ----
  "qoder.page.accounts.removed": "Deleted {name}",
  "qoder.page.accounts.domainMismatch": "Belongs to a different realm",
  "qoder.page.accounts.delete.title": "Delete account",
  "qoder.page.accounts.delete.desc": "Delete “{name}”? It moves to the recycle bin and can be restored.",
  "qoder.page.accounts.delete.batchTitle": "Delete selected accounts",
  "qoder.page.accounts.delete.batchDesc": "Delete the {n} selected accounts? They move to the recycle bin and can be restored.",
  "qoder.page.accounts.delete.confirm": "Delete",
  "qoder.page.accounts.delete.cancel": "Cancel",
  "qoder.page.accounts.delete.done": "Deleted {n} accounts",
  "qoder.page.accounts.delete.partial": "Deleted {ok}, {fail} failed",

  "qoder.page.accounts.remark.saved": "Remark saved",
  "qoder.page.accounts.remark.missing": "That account is no longer in the store — remark not saved",

  // Source ids are backend data (`qoder::account::SOURCE_*`); unknown values render as-is.
  "qoder.page.accounts.origin.pat": "Imported via PAT",
  "qoder.page.accounts.origin.desktopApp": "Imported from desktop app",
  "qoder.page.accounts.origin.cli": "Imported from CLI",
  "qoder.page.accounts.origin.oauth": "Device-code sign-in",

  // ── Program slots / switching / nickname / group (added 2026-10-15) ──
  "qoder.page.accounts.program.desktop": "Qoder Desktop",
  "qoder.page.accounts.program.cli": "Qoder CLI",
  "qoder.page.accounts.program.desktopShort": "Desktop",
  "qoder.page.accounts.program.cliShort": "CLI",
  "qoder.page.accounts.program.current": "Signed in",
  "qoder.page.accounts.program.currentOf": "{label} current account",
  "qoder.page.accounts.program.switchTo": "Switch to this account",
  "qoder.page.accounts.program.running": "Client is running",
  "qoder.page.accounts.program.runningHint": "Quit the client first — on exit it writes its in-memory sign-in state back, overwriting this switch.",
  "qoder.page.accounts.program.runningHintAuto": "The client is running — it will be closed for the switch and reopened afterwards.",
  "qoder.page.accounts.program.missing": "Not detected",
  "qoder.page.accounts.program.unreadable": "Unreadable",
  "qoder.page.accounts.program.empty": "Not signed in",
  "qoder.page.accounts.switch.done": "Switched to {name}",
  "qoder.page.accounts.switch.backup": "Previous sign-in state backed up to {path}",
  "qoder.page.accounts.switch.loading": "Switching to “{name}”",
  "qoder.page.accounts.switch.loadingAuto": "{program} will be reopened after the write (closed first if it is running)",
  "qoder.page.accounts.switch.loadingManual": "{program} will not be restarted",
  "qoder.page.accounts.switch.failed": "Switch failed",
  "qoder.page.accounts.switch.relaunchFailed": "Sign-in state switched, but the client could not be reopened: {error}",
  "qoder.page.accounts.group.label": "Group",
  "qoder.page.accounts.group.placeholder": "Leave empty for ungrouped",
  "qoder.page.accounts.group.saved": "Group saved",
  "qoder.page.accounts.group.missing": "This account is no longer in the library — group not saved",
  "qoder.page.accounts.toolbar.group.group": "By custom group",
  "qoder.page.accounts.toolbar.group.program": "By program",
  "qoder.page.accounts.toolbar.programBucket.none": "Not signed in to any program slot",
  "qoder.page.accounts.toolbar.groupBucket.ungrouped": "Ungrouped",
  "qoder.page.accounts.card.setGroup": "Set group",
  "qoder.page.accounts.refresh.batchPartial": "{ok} refreshed, {fail} failed",

  // ── Usage (unit is credits, not tokens) ──
  "qoder.page.usage.title": "Usage",
  "qoder.page.usage.subtitle": "{scope} · last {days} days · unit {unit}",
  "qoder.page.usage.unit.credits": "Credits",
  "qoder.page.usage.sourceNote":
    "Data comes from the local Qoder client session records. Qoder bills in credits and the client records a token count of 0 — so this view reports credits, not tokens.",
  "qoder.page.usage.totals.credits": "Total credits",
  "qoder.page.usage.totals.requests": "Requests",
  "qoder.page.usage.totals.sessions": "Sessions",
  "qoder.page.usage.totals.models": "Models",
  "qoder.page.usage.totals.sessionsCustomHint": "Custom ranges cannot de-duplicate sessions",
  "qoder.page.usage.trend": "Daily credits",
  "qoder.page.usage.byModel": "By model",
  "qoder.page.usage.empty.title": "No usage in this window",
  "qoder.page.usage.empty.description": "No request in the local client session records falls inside this window.",
  "qoder.page.usage.missing.title": "No client session records found",
  "qoder.page.usage.missing.description":
    "There is no Qoder client session directory on this machine ({path}) — install the client and have at least one conversation.",
  "qoder.page.usage.loadFailed": "Failed to read usage",
  "qoder.page.usage.recheck": "Reload",
  "qoder.page.usage.window.label": "Window",
  "qoder.page.usage.window.d7": "Last 7 days",
  "qoder.page.usage.window.d30": "Last 30 days",
  "qoder.page.usage.window.d90": "Last 90 days",
  "qoder.page.usage.window.all": "All",
  "qoder.page.usage.creditsValue": "{value} credits",
  "qoder.page.usage.caption": "{total} credits total · {peak} peak day",

  // ── Usage · credits (live balance snapshot, issue #111) ──
  "qoder.page.usage.creditsView.remaining": "Remaining",
  "qoder.page.usage.creditsView.total": "Quota total",
  "qoder.page.usage.creditsView.okAccounts": "Accounts OK",
  "qoder.page.usage.creditsView.failedAccounts": "Failed",
  "qoder.page.usage.creditsView.perAccount": "Balance per account",
  "qoder.page.usage.creditsView.value": "{remaining} / {total}",
  "qoder.page.usage.creditsView.exceeded": "Exceeded",
  "qoder.page.usage.creditsView.plan": "Plan {plan}",
  "qoder.page.usage.creditsView.note": "This is a **live balance snapshot** (queried upstream), not daily usage; quota resets by upstream rules.",
  "qoder.page.usage.creditsView.empty": "No accounts in this region yet — import one on the Accounts page to see balances.",
  "qoder.page.usage.creditsView.loadFailed": "Couldn't read balances",
  "qoder.page.usage.creditsView.rowFailed": "Failed: {error}",
  "qoder.page.usage.creditsView.partial": "{n} accounts failed (others shown as usual)",
  "qoder.page.usage.creditsView.reload": "Query again",

  // ── OAuth device authorization (added 2026-10-15: the capability was declared long ago) ──
  "qoder.page.accounts.oauth.title": "Device-code sign-in",
  "qoder.page.accounts.oauth.description":
    "Authorize Qoder in your browser; the account is collected here automatically. The two realms use different authorization pages, chosen by the current scope.",
  "qoder.page.accounts.oauth.start": "Start sign-in",
  "qoder.page.accounts.oauth.starting": "Starting…",
  "qoder.page.accounts.oauth.waiting": "Waiting for the browser to finish authorization…",
  "qoder.page.accounts.oauth.collected": "Account collected: {name}",
  "qoder.page.accounts.oauth.failed": "Sign-in failed",
  "qoder.page.accounts.oauth.close": "Close",
  "qoder.page.accounts.oauth.entry": "Device-code sign-in",
  "qoder.page.accounts.oauth.entryDesc": "Authorize in a browser — useful when the Qoder client is not installed",

  // ── Recycle bin (soft delete) ──
  "qoder.page.accounts.trash.restored": "Restored {name}",
  "qoder.page.accounts.trash.undo": "Undo",

  // ── Check-in / quota (backend was ready; there was no UI entry) ──
  "qoder.page.accounts.chip.checkedIn": "Checked in today",
  "qoder.page.accounts.chip.notCheckedIn": "Not checked in",
  "qoder.page.accounts.chip.checkinUnavailable": "Check-in unavailable",
  "qoder.page.accounts.metric.credits": "Credits",
  // 2026-10-26: `{remaining} / {total}` removed — card and table render
  // `<b>remaining</b>/total` separately (thousands via `formatCredits`), matching WB.
  // 2026-10-28: this domain's `metric.creditsTip` was dropped — the "remaining · total · used"
  // line now comes from `creditMetricTip` in `account-card.tsx` (WB's key), one copy for all three.
  // 2026-10-28 (user request): `metric.plan` dropped — the card's metric row no longer
  // shows the plan name; it only labels the drawer's credit pack row (from `plan` itself).
  "qoder.page.accounts.card.priority": "Priority",
  "qoder.page.accounts.card.priorityTip": "Recommended priority",
  // 2026-10-27: quota expiry now appears on the drawer's credit pack row (top-level
  // `expiresAt`, Unix milliseconds per the Qoder SDK).
  "qoder.page.accounts.metric.used": "Used {n}",
  "qoder.page.accounts.metric.expiresOn": "Expires {date}",
  // 2026-10-29: upstream sends 9999-12-31 as a "never expires" sentinel; core folds it
  // into `expiresForever` so the UI never prints the fake date.
  "qoder.page.accounts.metric.neverExpires": "Never expires",
  "qoder.page.accounts.metric.expired": "Expired",

  // ── Qoder web per-pack detail (issue #111) ──
  "qoder.page.accounts.web.loginMenu": "Sign in to Qoder web (per-pack detail)",
  "qoder.page.accounts.web.loginToast": "Sign-in window opened. Per-pack detail is read automatically once you sign in; you can also close the window and click \"Read per-pack detail\".",
  "qoder.page.accounts.web.read": "Signed in — read per-pack detail",
  "qoder.page.accounts.web.readDone": "Read {n} resource packs",
  "qoder.page.accounts.web.readFailed": "No per-pack detail yet. Make sure the sign-in window finished signing in, then retry.",
  "qoder.page.accounts.web.readMismatch": "The sign-in window was authenticated as a different account; that session was discarded.",
  "qoder.page.accounts.web.packsNotice": "Per-pack detail needs a one-time web sign-in (the session stays on this machine). Showing aggregate credits for now.",
  "qoder.page.accounts.web.packsNoticeReady": "{n} packs · web session stored on this machine",
  "qoder.page.accounts.web.logout": "Sign out of web",
  "qoder.page.accounts.web.logoutDone": "Web session cleared from this machine",
  "qoder.page.accounts.web.sourcePlan": "Plan quota",
  "qoder.page.accounts.web.sourceBonus": "Bonus pack",
  "qoder.page.accounts.web.sourceDedicated": "Dedicated pack",
  "qoder.page.accounts.web.sourceOther": "Resource pack",
  "qoder.page.accounts.web.neverExpires": "No expiry",
  "qoder.page.accounts.web.expired": "Expired",
  "qoder.page.accounts.web.packName": "{source} · {n}",
  "qoder.page.accounts.web.triggerUnsupported": "Desktop only",
  "qoder.page.accounts.web.triggerLoading": "Loading…",
  "qoder.page.accounts.web.triggerPacks": "{n} packs",
  "qoder.page.accounts.web.triggerNeutral": "Packs",
  "qoder.page.accounts.web.triggerNoSession": "Packs · not signed in",
  "qoder.page.accounts.web.triggerHint": "View per-pack detail",
  "qoder.page.accounts.web.title": "Per-pack detail",
  "qoder.page.accounts.web.summary": "{n} packs · {remaining} left",
  "qoder.page.accounts.web.loading": "Loading…",
  "qoder.page.accounts.web.used": "{n} used",
  "qoder.page.accounts.web.expiresAt": "expires {date}",
  "qoder.page.accounts.web.state.noSession": "Not signed in to Qoder web",
  "qoder.page.accounts.web.state.noSessionHint": "Per-pack detail lives behind the web endpoint. Sign in there once and it will be remembered.",
  "qoder.page.accounts.web.state.expired": "Web session expired",
  "qoder.page.accounts.web.state.expiredHint": "Sign in again — the account itself is fine.",
  "qoder.page.accounts.web.state.mismatch": "Web session belongs to another account",
  "qoder.page.accounts.web.state.mismatchHint": "The sign-in window was authenticated as a different account, so the session was discarded. Please sign in again.",
  "qoder.page.accounts.web.state.upstream": "Upstream did not respond",
  "qoder.page.accounts.web.state.upstreamHint": "This is not a sign-in problem. Retry later; the session is kept.",
  "qoder.page.accounts.web.state.unknown": "No per-pack data yet",
  "qoder.page.accounts.web.state.unknownHint": "Sign in to the web console to see how much each credit pack has left and when it expires.",
  "qoder.page.accounts.web.state.unsupported": "Per-pack unavailable in this build",
  "qoder.page.accounts.web.state.unsupportedHint": "Per-pack needs an embedded browser to capture the web session, so it is desktop-only. Aggregate credits work everywhere.",
  "qoder.page.accounts.credits.loading": "Loading quota…",
  "qoder.page.accounts.checkin.action": "Check in",
  "qoder.page.accounts.checkin.already": "{name} already checked in today",
  "qoder.page.accounts.checkin.done": "{name} checked in",
  "qoder.page.accounts.checkin.batchDone": "Checked in {n} accounts",
  "qoder.page.accounts.checkin.batchPartial": "{ok} succeeded, {fail} failed",
  "qoder.page.accounts.checkin.resultOk": "{n} checked in",
  "qoder.page.accounts.checkin.resultFail": "{n} failed",
  "qoder.page.accounts.refresh.done": "Token refreshed for {name}",
  "qoder.page.accounts.refresh.batchDone": "Refreshed tokens for {n} accounts",
  "qoder.page.accounts.refresh.syncFailed": "Renewal finished, but the UI sync failed",
  "qoder.page.accounts.refresh.syncFailedDesc":
    "The token was renewed, but the account list could not be re-read. Reload instead of renewing again.",

  "qoder.page.accounts.toolbar.group.source": "By source",
  "qoder.page.accounts.toolbar.group.checkin": "By check-in",
  "qoder.page.accounts.toolbar.checkinBucket.checkedIn": "Checked in today",
  "qoder.page.accounts.toolbar.checkinBucket.notCheckedIn": "Not checked in",
  "qoder.page.accounts.toolbar.checkinBucket.unknown": "Check-in state unknown",

  "qoder.page.pending.title": "This page is not wired for Qoder yet",
  "qoder.page.pending.description":
    "Accounts, usage, gateway and settings are available for Qoder; sessions depend on the client's session copies and are not landed yet.",
  "qoder.page.pending.action": "Go to accounts",

  // ---- Settings ----
  "qoder.page.settings.title": "Settings",
  // ---- Settings · Network (per-pack egress proxy, issue #111) ----
  "qoder.page.settings.proxy.group": "Per-pack egress proxy",
  "qoder.page.settings.proxy.cn": "CN proxy",
  "qoder.page.settings.proxy.cnHint": "Direct connection usually works for CN; leave blank.",
  "qoder.page.settings.proxy.global": "Global proxy",
  "qoder.page.settings.proxy.globalHint": "The global endpoint routes by IP; direct access from CN is usually blocked, so a proxy is normally required.",
  "qoder.page.settings.proxy.note": "Applies only to per-pack detail requests (http:// or socks5://). The sign-in window uses the system proxy and is unaffected; save applies immediately.",
  "qoder.page.settings.proxy.save": "Save proxy settings",
  "qoder.page.settings.proxy.saving": "Saving…",
  "qoder.page.settings.proxy.saved": "Proxy settings saved",
  "qoder.page.settings.proxy.saveFailed": "Failed to save proxy settings",
  "qoder.page.settings.section.client": "Client detection",
  "qoder.page.settings.client.description": "Probe result for the two official credential stores (read-only).",
  "qoder.page.settings.client.error": "Probe failed: {error}",
  // ★ Scheduled tasks (Qoder has two; the schedule config is a single global file)
  "qoder.page.settings.schedule.checkinGroup": "Auto check-in",
  "qoder.page.settings.schedule.checkinEnable": "Check in on schedule",
  "qoder.page.settings.schedule.checkinDesc":
    "Claims the campaign credit reward at the configured times (off by default — it acts on your behalf, so it must be opted in).",
  "qoder.page.settings.schedule.checkinTimesLabel": "Check-in times",
  "qoder.page.settings.schedule.checkinTimesDesc":
    "One attempt at each time (local timezone); jitter is applied so it never lands on the same second as the official client.",
  "qoder.page.settings.schedule.keepaliveGroup": "Token keep-alive",
  "qoder.page.settings.schedule.keepaliveEnable": "Refresh the token automatically",
  "qoder.page.settings.schedule.keepaliveDesc":
    "Refreshes within 48 hours of expiry (on by default: a refresh token exists solely to be refreshed, and you handed it over at login). The window must be longer than the sweep interval (once a day by default); otherwise every sweep decides \"not yet\" and the account expires between sweeps.",
  "qoder.page.settings.schedule.keepaliveTimesLabel": "Keep-alive times",
  "qoder.page.settings.schedule.keepaliveTimesDesc": "Checks once at each of these times whether the token is close to expiry.",
  "qoder.page.settings.schedule.saveFailed": "Failed to save scheduled tasks",
  "qoder.page.settings.filtered":
    "Only client-specific sections with real content are listed; General and Backup now live in App settings. Check-in / gateway / permissions / log settings will appear once those features land (no empty shells are shown up front).",
} as const;
