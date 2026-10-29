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
  "qoder.page.accounts.program.missing": "Not detected",
  "qoder.page.accounts.program.unreadable": "Unreadable",
  "qoder.page.accounts.program.empty": "Not signed in",
  "qoder.page.accounts.switch.title": "Switch account",
  "qoder.page.accounts.switch.desc":
    "Write the credentials of “{name}” into {program}. The current sign-in state is backed up first; a failed verification restores it automatically.",
  "qoder.page.accounts.switch.confirm": "Switch",
  "qoder.page.accounts.switch.cancel": "Cancel",
  "qoder.page.accounts.switch.done": "Switched to {name}",
  "qoder.page.accounts.switch.backup": "Previous sign-in state backed up to {path}",
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
    "Refreshes within 4 hours of expiry (on by default: a refresh token exists solely to be refreshed, and you handed it over at login).",
  "qoder.page.settings.schedule.keepaliveTimesLabel": "Keep-alive times",
  "qoder.page.settings.schedule.keepaliveTimesDesc": "Checks once at each of these times whether the token is close to expiry.",
  "qoder.page.settings.schedule.saveFailed": "Failed to save scheduled tasks",
  "qoder.page.settings.filtered":
    "Only client-specific sections with real content are listed; General and Backup now live in App settings. Check-in / gateway / permissions / log settings will appear once those features land (no empty shells are shown up front).",
} as const;
