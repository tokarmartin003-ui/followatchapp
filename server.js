“use strict”;

const express = require(“express”);
const session = require(“express-session”);
const cors = require(“cors”);
const cron = require(“node-cron”);
const path = require(“path”);
const fs = require(“fs”);
const {
IgApiClient,
IgCheckpointError,
IgLoginTwoFactorRequiredError,
} = require(“instagram-private-api”);

// ———————————————————––
//  CONFIG
// ———————————————————––
const PORT      = process.env.PORT      || 3000;
const DB_PATH   = path.join(__dirname, “db.json”);
const PROXY_URL = process.env.PROXY_URL || null;

// ———————————————————––
//  LOGGING
// ———————————————————––
function log(tag, msg) {
const t = new Date().toLocaleTimeString(“en-US”, { hour12: false });
console.log(`[${t}] [${tag}] ${msg}`);
}

// ———————————————————––
//  UTILITIES
// ———————————————————––
function sleep(ms) {
return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function fmtDate(ts) {
return new Date(ts).toLocaleString(“en-US”, {
weekday: “short”,
month: “long”,
day: “numeric”,
year: “numeric”,
hour: “2-digit”,
minute: “2-digit”,
second: “2-digit”,
});
}

// ———————————————————––
//  DATABASE  - atomic writes prevent corruption
// ———————————————————––
function dbRead() {
if (!fs.existsSync(DB_PATH)) {
var blank = { accounts: {}, spyTargets: {} };
fs.writeFileSync(DB_PATH, JSON.stringify(blank, null, 2));
return blank;
}
try {
return JSON.parse(fs.readFileSync(DB_PATH, “utf8”));
} catch (e) {
log(“db”, “Read error, returning blank: “ + e.message);
return { accounts: {} };
}
}

function dbWrite(data) {
var tmp = DB_PATH + “.tmp”;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
fs.renameSync(tmp, DB_PATH);
}

// ———————————————————––
//  IN-MEMORY STORES
// ———————————————————––
var igSessions    = {};
var pendingLogins = {};
var syncLocks     = {};

// ———————————————————––
//  IG CLIENT FACTORY
// ———————————————————––
function makeIgClient(username) {
var ig = new IgApiClient();
ig.state.generateDevice(username);
if (PROXY_URL) {
ig.state.proxyUrl = PROXY_URL;
log(“proxy”, “@” + username + “ routed through proxy”);
}
return ig;
}

// ———————————————————––
//  FETCH ALL FOLLOWERS  with retry + progress
// ———————————————————––
async function fetchAllFollowers(ig, userId, onCount) {
var feed    = ig.feed.accountFollowers(userId);
var results = [];
var page    = 0;

do {
var items;
var lastErr;
for (var attempt = 1; attempt <= 3; attempt++) {
try {
items = await feed.items();
lastErr = null;
break;
} catch (err) {
lastErr = err;
if (attempt < 3) {
log(“fetch”, “Page “ + page + “ attempt “ + attempt + “ failed, retrying…”);
await sleep(attempt * 2000);
}
}
}
if (lastErr) throw lastErr;

```
for (var i = 0; i < items.length; i++) {
  var u = items[i];
  results.push({
    pk:              String(u.pk),
    username:        u.username        || "",
    full_name:       u.full_name       || "",
    profile_pic_url: u.profile_pic_url || "",
  });
}

page++;
if (onCount) onCount(results.length);

await sleep(page % 5 === 0 ? 2000 : 900);
if (page > 300) break;
```

} while (feed.isMoreAvailable());

return results;
}

// ———————————————————––
//  COMPARE FOLLOWERS
// ———————————————————––
function compareFollowers(oldList, newList) {
var newPKs = new Set(newList.map(function(u) { return u.pk; }));
var oldPKs = new Set(oldList.map(function(u) { return u.pk; }));
var ts  = Date.now();
var fmt = fmtDate(ts);

var unfollowers = oldList
.filter(function(u) { return !newPKs.has(u.pk); })
.map(function(u) {
return Object.assign({}, u, {
unfollowedAt:          ts,
unfollowedAtFormatted: fmt,
dismissed:             false,
});
});

var gained = newList
.filter(function(u) { return !oldPKs.has(u.pk); })
.map(function(u) {
return Object.assign({}, u, {
followedAt:          ts,
followedAtFormatted: fmt,
});
});

return { unfollowers: unfollowers, gained: gained };
}

// ———————————————————––
//  FINALIZE LOGIN
// ———————————————————––
async function finalizeLogin(ig, user, username, req) {
var serialized = await ig.state.serialize();
delete serialized.constants;

igSessions[username]    = { ig: ig, userId: String(user.pk) };
delete pendingLogins[username];

var db       = dbRead();
var existing = db.accounts[username] || {};

db.accounts[username] = {
username:         username,
userId:           String(user.pk),
fullName:         user.full_name       || existing.fullName   || “”,
profilePic:       user.profile_pic_url || existing.profilePic || “”,
currentFollowers: existing.currentFollowers || [],
unfollowers:      existing.unfollowers      || [],
gainedFollowers:  existing.gainedFollowers   || [],
snapshots:        existing.snapshots         || [],
tracking:         existing.tracking          || false,
lastChecked:      existing.lastChecked       || null,
sessionState:     serialized,
};

dbWrite(db);
req.session.username = username;
log(“auth”, “@” + username + “ logged in successfully”);
}

// ———————————————————––
//  REHYDRATE SESSION FROM DISK
// ———————————————————––
async function rehydrate(username) {
if (igSessions[username]) return igSessions[username];

var db      = dbRead();
var account = db.accounts[username];
if (!account || !account.sessionState) return null;

try {
var ig = makeIgClient(username);
await ig.state.deserialize(account.sessionState);
igSessions[username] = { ig: ig, userId: account.userId };
log(“session”, “@” + username + “ session restored from disk”);
return igSessions[username];
} catch (e) {
log(“session”, “@” + username + “ restore failed: “ + e.message);
return null;
}
}

// ———————————————————––
//  CORE SYNC
// ———————————————————––
async function runSync(username, onProgress) {
if (syncLocks[username]) {
throw new Error(“SYNC_IN_PROGRESS”);
}
syncLocks[username] = true;

function notify(msg, pct) {
if (onProgress) onProgress(msg, pct);
}

try {
var s = await rehydrate(username);
if (!s) throw new Error(“SESSION_EXPIRED”);

```
notify("Connecting to Instagram...", 5);

var db      = dbRead();
var account = db.accounts[username];
if (!account) throw new Error("Account not found in database");

notify("Fetching your followers...", 10);

var newFollowers = await fetchAllFollowers(s.ig, s.userId, function(count) {
  var pct = Math.min(10 + Math.floor(count / 5), 75);
  notify("Fetching followers... " + count + " loaded", pct);
});

notify("Comparing with previous snapshot...", 80);

var oldFollowers = account.currentFollowers || [];
var isBaseline   = oldFollowers.length === 0;

var compared = isBaseline
  ? { unfollowers: [], gained: [] }
  : compareFollowers(oldFollowers, newFollowers);

var newUnfollowers = compared.unfollowers;
var gained         = compared.gained;

var existingUMap = {};
(account.unfollowers || []).forEach(function(u) { existingUMap[u.pk] = u; });
newUnfollowers.forEach(function(u) {
  if (!existingUMap[u.pk]) existingUMap[u.pk] = u;
});
var mergedUnfollowers = Object.values(existingUMap);

var existingGMap = {};
(account.gainedFollowers || []).forEach(function(u) { existingGMap[u.pk] = u; });
gained.forEach(function(u) { existingGMap[u.pk] = u; });
var mergedGained = Object.values(existingGMap).slice(-200);

var ts = Date.now();
account.currentFollowers = newFollowers;
account.unfollowers      = mergedUnfollowers;
account.gainedFollowers  = mergedGained;
account.snapshots        = (account.snapshots || []).slice(-49).concat([{
  timestamp:  ts,
  count:      newFollowers.length,
  unfollowed: newUnfollowers.length,
  gained:     gained.length,
}]);
account.lastChecked = ts;
account.tracking    = true;

dbWrite(db);
notify("Done!", 100);

log("sync", "@" + username + ": " + newFollowers.length + " followers | -" + newUnfollowers.length + " unfollowed | +" + gained.length + " gained");

return {
  isBaseline:       isBaseline,
  followerCount:    newFollowers.length,
  newUnfollowers:   newUnfollowers.length,
  gained:           gained.length,
  totalUnfollowers: mergedUnfollowers.filter(function(u) { return !u.dismissed; }).length,
};
```

} finally {
delete syncLocks[username];
}
}

// ———————————————————––
//  EXPRESS SETUP
// ———————————————————––
var app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, “public”)));
app.use(session({
secret:            “fw-” + (process.env.SESSION_SECRET || “followwatch2024xK9”),
resave:            false,
saveUninitialized: false,
cookie:            { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true },
}));

// ———————————————————––
//  ROUTE: GET /api/status
// ———————————————————––
app.get(”/api/status”, function(req, res) {
var username = req.session.username;
if (!username) return res.json({ loggedIn: false });

var db      = dbRead();
var account = db.accounts[username];
if (!account) return res.json({ loggedIn: false });

return res.json({
loggedIn:        true,
username:        account.username,
fullName:        account.fullName   || “”,
profilePic:      account.profilePic || “”,
followerCount:   (account.currentFollowers || []).length,
unfollowerCount: (account.unfollowers || []).filter(function(u) { return !u.dismissed; }).length,
gainedCount:     (account.gainedFollowers  || []).length,
snapshotCount:   (account.snapshots        || []).length,
lastChecked:     account.lastChecked || null,
tracking:        account.tracking    || false,
isBaseline:      (account.currentFollowers || []).length === 0,
syncInProgress:  !!syncLocks[username],
});
});

// ———————————————————––
//  ROUTE: POST /api/login
// ———————————————————––
app.post(”/api/login”, async function(req, res) {
var username = req.body.username;
var password = req.body.password;

if (!username || !password) {
return res.status(400).json({ error: “Username and password are required.” });
}

var clean = username.trim().toLowerCase().replace(/^@/, “”);
var ig    = makeIgClient(clean);

try {
await ig.simulate.preLoginFlow();
var user = await ig.account.login(clean, password);
try { await ig.simulate.postLoginFlow(); } catch (e) { /* non-fatal */ }
await finalizeLogin(ig, user, clean, req);
return res.json({ success: true, username: clean, fullName: user.full_name || “” });

} catch (err) {
var errMsg  = (err.message || “”).toLowerCase();
var errBody = {};
try { errBody = err.response && err.response.body ? err.response.body : {}; } catch (e) {}

```
log("login", "Error for @" + clean + ": " + err.message);

var isCheckpoint = (
  err instanceof IgCheckpointError ||
  errMsg.includes("checkpoint") ||
  errMsg.includes("challenge_required") ||
  errMsg.includes("we can send you an email") ||
  errMsg.includes("help you get back") ||
  errMsg.includes("please wait a few minutes") ||
  (errBody && errBody.error_type === "checkpoint_required") ||
  (errBody && errBody.message   === "checkpoint_required")
);

if (isCheckpoint) {
  log("login", "@" + clean + " triggered checkpoint");
  var triggered = false;

  if (!triggered) {
    try {
      await ig.challenge.auto(true);
      triggered = true;
    } catch (e1) {
      log("login", "challenge.auto failed: " + e1.message);
    }
  }

  if (!triggered) {
    try {
      await ig.challenge.selectVerifyMethod("1");
      triggered = true;
    } catch (e2) {
      log("login", "selectVerifyMethod(email) failed: " + e2.message);
    }
  }

  if (!triggered) {
    try {
      await ig.challenge.selectVerifyMethod("0");
      triggered = true;
    } catch (e3) {
      log("login", "selectVerifyMethod(sms) failed: " + e3.message);
    }
  }

  if (triggered) {
    pendingLogins[clean] = { ig: ig, type: "checkpoint" };
    return res.json({
      status:  "checkpoint",
      message: "Instagram sent a verification code to your email or phone. Enter it below.",
    });
  } else {
    return res.status(403).json({
      error: "Instagram is blocking this login. Please open the Instagram app, go to Settings -> Security -> Emails From Instagram, approve the login notification, then try again.",
    });
  }
}

var isTwoFactor = (
  err instanceof IgLoginTwoFactorRequiredError ||
  errMsg.includes("two_factor") ||
  errMsg.includes("two factor") ||
  (errBody && errBody.two_factor_required === true)
);

if (isTwoFactor) {
  log("login", "@" + clean + " requires 2FA");
  var info = {};
  try { info = err.response.body.two_factor_info || {}; } catch (e) {}

  var methods = [];
  if (info.totp_two_factor_on)     methods.push("totp");
  if (info.sms_two_factor_on)      methods.push("sms");
  if (info.whatsapp_two_factor_on) methods.push("whatsapp");
  if (methods.length === 0)        methods.push("sms");

  pendingLogins[clean] = { ig: ig, type: "twofactor", twoFactorInfo: info };
  return res.json({ status: "twofactor", methods: methods });
}

var isBadPassword = (
  errMsg.includes("bad_password")  ||
  errMsg.includes("invalid_user")  ||
  errMsg.includes("incorrect")     ||
  errMsg.includes("wrong password") ||
  (errBody && errBody.invalid_credentials === true)
);

if (isBadPassword) {
  return res.status(401).json({ error: "Incorrect username or password. Please try again." });
}

return res.status(500).json({ error: "Login failed: " + (err.message || "Unknown error") });
```

}
});

// ———————————————————––
//  ROUTE: POST /api/verify-checkpoint
// ———————————————————––
app.post(”/api/verify-checkpoint”, async function(req, res) {
var username = req.body.username;
var code     = req.body.code;

if (!username || !code) {
return res.status(400).json({ error: “Username and code are required.” });
}

var clean   = username.trim().toLowerCase().replace(/^@/, “”);
var pending = pendingLogins[clean];

if (!pending || pending.type !== “checkpoint”) {
return res.status(400).json({ error: “No pending checkpoint. Please log in again.” });
}

try {
var user = await pending.ig.challenge.sendSecurityCode(code.trim());
try { await pending.ig.simulate.postLoginFlow(); } catch (e) { /* non-fatal */ }
await finalizeLogin(pending.ig, user, clean, req);
log(“auth”, “@” + clean + “ checkpoint verified”);
return res.json({ success: true, username: clean, fullName: user.full_name || “” });
} catch (err) {
var msg = (err.message || “”).toLowerCase();
log(“auth”, “@” + clean + “ checkpoint verify failed: “ + err.message);
if (msg.includes(“wrong”) || msg.includes(“incorrect”) || msg.includes(“invalid”) || msg.includes(“400”) || msg.includes(“bad”) || msg.includes(“expired”)) {
return res.status(400).json({ error: “That code is incorrect or expired. Please try again.” });
}
return res.status(500).json({ error: “Verification failed: “ + err.message });
}
});

// ———————————————————––
//  ROUTE: POST /api/verify-2fa
// ———————————————————––
app.post(”/api/verify-2fa”, async function(req, res) {
var username = req.body.username;
var code     = req.body.code;
var method   = req.body.method;

if (!username || !code) {
return res.status(400).json({ error: “Username and code are required.” });
}

var clean   = username.trim().toLowerCase().replace(/^@/, “”);
var pending = pendingLogins[clean];

if (!pending || pending.type !== “twofactor”) {
return res.status(400).json({ error: “No pending 2FA. Please log in again.” });
}

try {
var ig            = pending.ig;
var twoFactorInfo = pending.twoFactorInfo || {};

```
var verificationMethod = "1";
if (method === "totp")     verificationMethod = "0";
if (method === "whatsapp") verificationMethod = "2";

var user = await ig.account.twoFactorLogin({
  username:            twoFactorInfo.username || clean,
  verificationCode:    code.trim().replace(/\s+/g, ""),
  twoFactorIdentifier: twoFactorInfo.two_factor_identifier || "",
  verificationMethod:  verificationMethod,
  trustThisDevice:     "1",
});

try { await ig.simulate.postLoginFlow(); } catch (e) { /* non-fatal */ }
await finalizeLogin(ig, user, clean, req);
log("auth", "@" + clean + " 2FA verified via " + method);
return res.json({ success: true, username: clean, fullName: user.full_name || "" });
```

} catch (err) {
var msg = (err.message || “”).toLowerCase();
log(“auth”, “@” + clean + “ 2FA failed: “ + err.message);
if (msg.includes(“wrong”) || msg.includes(“incorrect”) || msg.includes(“invalid”) || msg.includes(“400”) || msg.includes(“bad”) || msg.includes(“expired”)) {
return res.status(400).json({ error: “That code is incorrect or expired. Please try again.” });
}
return res.status(500).json({ error: “2FA failed: “ + err.message });
}
});

// ———————————————————––
//  ROUTE: POST /api/logout
// ———————————————————––
app.post(”/api/logout”, function(req, res) {
var username = req.session.username;
if (username) {
delete igSessions[username];
delete pendingLogins[username];
log(“auth”, “@” + username + “ logged out”);
}
req.session.destroy(function() {});
return res.json({ success: true });
});

// ———————————————————––
//  ROUTE: GET /api/sync  (Server-Sent Events)
// ———————————————————––
app.get(”/api/sync”, async function(req, res) {
var username = req.session.username;
if (!username) {
return res.status(401).json({ error: “Not logged in” });
}

res.setHeader(“Content-Type”,  “text/event-stream”);
res.setHeader(“Cache-Control”, “no-cache”);
res.setHeader(“Connection”,    “keep-alive”);
res.setHeader(“X-Accel-Buffering”, “no”);
res.flushHeaders();

var keepAlive = setInterval(function() {
try { res.write(”: ping\n\n”); } catch (e) { clearInterval(keepAlive); }
}, 20000);

function send(payload) {
try { res.write(“data: “ + JSON.stringify(payload) + “\n\n”); } catch (e) {}
}

try {
var result = await runSync(username, function(message, pct) {
send({ type: “progress”, message: message, pct: pct });
});
send({ type: “done”, result: result });
} catch (err) {
var errMsg = err.message || “Unknown error”;
if (errMsg === “SESSION_EXPIRED”) {
send({ type: “error”, message: “Session expired. Please sign out and log in again.” });
} else if (errMsg === “SYNC_IN_PROGRESS”) {
send({ type: “error”, message: “A sync is already running. Please wait.” });
} else {
send({ type: “error”, message: “Sync failed: “ + errMsg });
}
} finally {
clearInterval(keepAlive);
res.end();
}
});

// ———————————————————––
//  ROUTE: GET /api/data
// ———————————————————––
app.get(”/api/data”, function(req, res) {
var username = req.session.username;
if (!username) return res.status(401).json({ error: “Not logged in” });

var db      = dbRead();
var account = db.accounts[username];
if (!account) return res.status(404).json({ error: “Account not found” });

return res.json({
username:        account.username,
fullName:        account.fullName        || “”,
profilePic:      account.profilePic      || “”,
followerCount:   (account.currentFollowers || []).length,
unfollowers:     (account.unfollowers     || []).filter(function(u) { return !u.dismissed; }),
dismissedCount:  (account.unfollowers     || []).filter(function(u) { return  u.dismissed; }).length,
gainedFollowers: (account.gainedFollowers  || []).slice(-50).reverse(),
snapshots:       account.snapshots        || [],
lastChecked:     account.lastChecked      || null,
tracking:        account.tracking         || false,
isBaseline:      (account.currentFollowers || []).length === 0,
syncInProgress:  !!syncLocks[username],
});
});

// ———————————————————––
//  ROUTE: POST /api/dismiss/:pk
// ———————————————————––
app.post(”/api/dismiss/:pk”, function(req, res) {
var username = req.session.username;
if (!username) return res.status(401).json({ error: “Not logged in” });

var db      = dbRead();
var account = db.accounts[username];
if (!account) return res.status(404).json({ error: “Not found” });

var entry = (account.unfollowers || []).find(function(u) { return u.pk === req.params.pk; });
if (entry) entry.dismissed = true;
dbWrite(db);
return res.json({ success: true });
});

// ———————————————————––
//  ROUTE: POST /api/dismiss-all
// ———————————————————––
app.post(”/api/dismiss-all”, function(req, res) {
var username = req.session.username;
if (!username) return res.status(401).json({ error: “Not logged in” });

var db      = dbRead();
var account = db.accounts[username];
if (!account) return res.status(404).json({ error: “Not found” });

(account.unfollowers || []).forEach(function(u) { u.dismissed = true; });
dbWrite(db);
return res.json({ success: true });
});

// ———————————————————––
//  ROUTE: POST /api/clear-data
// ———————————————————––
app.post(”/api/clear-data”, function(req, res) {
var username = req.session.username;
if (!username) return res.status(401).json({ error: “Not logged in” });

var db      = dbRead();
var account = db.accounts[username];
if (!account) return res.status(404).json({ error: “Not found” });

account.currentFollowers = [];
account.unfollowers      = [];
account.gainedFollowers  = [];
account.snapshots        = [];
account.tracking         = false;
account.lastChecked      = null;
dbWrite(db);
log(“data”, “@” + username + “ cleared all data”);
return res.json({ success: true });
});

// ———————————————————––
//  ROUTE: DELETE /api/delete-account
// ———————————————————––
app.delete(”/api/delete-account”, function(req, res) {
var username = req.session.username;
if (!username) return res.status(401).json({ error: “Not logged in” });

var db = dbRead();
delete db.accounts[username];
if (db.spyTargets) delete db.spyTargets[username];
dbWrite(db);

delete igSessions[username];
req.session.destroy(function() {});
log(“data”, “@” + username + “ deleted their account and all data”);
return res.json({ success: true });
});

// ———————————————————––
//  ROUTE: POST /api/spy/add
// ———————————————————––
app.post(”/api/spy/add”, async function(req, res) {
var username   = req.session.username;
var targetUser = (req.body.targetUser || “”).trim().toLowerCase().replace(/^@/, “”);

if (!username)   return res.status(401).json({ error: “Not logged in” });
if (!targetUser) return res.status(400).json({ error: “Target username is required.” });

var s = await rehydrate(username);
if (!s) return res.status(401).json({ error: “Session expired. Please log in again.” });

try {
var targetInfo = await s.ig.user.searchExact(targetUser);
if (!targetInfo) return res.status(404).json({ error: “User @” + targetUser + “ not found.” });

```
var targetId = String(targetInfo.pk);

var feed    = s.ig.feed.userFollowing(targetId);
var results = [];
var page    = 0;
do {
  var items = await feed.items();
  for (var i = 0; i < items.length; i++) {
    results.push({
      pk:              String(items[i].pk),
      username:        items[i].username        || "",
      full_name:       items[i].full_name       || "",
      profile_pic_url: items[i].profile_pic_url || "",
      followedAt:      Date.now(),
    });
  }
  page++;
  await sleep(900);
  if (page > 100) break;
} while (feed.isMoreAvailable());

var db = dbRead();
if (!db.spyTargets) db.spyTargets = {};
if (!db.spyTargets[username]) db.spyTargets[username] = {};

var existing = db.spyTargets[username][targetUser];
var now      = Date.now();
var oneMonth = 30 * 24 * 60 * 60 * 1000;

var newFollows = [];
if (existing && existing.following) {
  var oldPKs = new Set(existing.following.map(function(u) { return u.pk; }));
  newFollows = results
    .filter(function(u) { return !oldPKs.has(u.pk); })
    .map(function(u) { return Object.assign({}, u, { followedAt: now, followedAtFormatted: fmtDate(now) }); });

  var merged = (existing.recentFollows || [])
    .filter(function(u) { return now - u.followedAt < oneMonth; })
    .concat(newFollows);

  var seen = {};
  merged = merged.filter(function(u) {
    if (seen[u.pk]) return false;
    seen[u.pk] = true;
    return true;
  });

  db.spyTargets[username][targetUser].following     = results;
  db.spyTargets[username][targetUser].recentFollows = merged;
  db.spyTargets[username][targetUser].lastChecked   = now;
  db.spyTargets[username][targetUser].newThisCheck  = newFollows.length;
} else {
  db.spyTargets[username][targetUser] = {
    targetUser:    targetUser,
    targetId:      targetId,
    displayName:   targetInfo.full_name || targetUser,
    profilePic:    targetInfo.profile_pic_url || "",
    following:     results,
    recentFollows: [],
    lastChecked:   now,
    addedAt:       now,
    newThisCheck:  0,
  };
}

dbWrite(db);
log("spy", "@" + username + " tracking @" + targetUser + " (" + results.length + " following)");
return res.json({
  success:        true,
  targetUser:     targetUser,
  followingCount: results.length,
  recentFollows:  db.spyTargets[username][targetUser].recentFollows,
  isBaseline:     !existing,
});
```

} catch (err) {
log(“spy”, “Error tracking @” + targetUser + “: “ + err.message);
if ((err.message || “”).toLowerCase().includes(“not found”) || (err.message || “”).includes(“404”)) {
return res.status(404).json({ error: “User @” + targetUser + “ not found or account is private.” });
}
return res.status(500).json({ error: “Could not fetch data for @” + targetUser + “: “ + err.message });
}
});

// ———————————————————––
//  ROUTE: GET /api/spy/list
// ———————————————————––
app.get(”/api/spy/list”, function(req, res) {
var username = req.session.username;
if (!username) return res.status(401).json({ error: “Not logged in” });

var db      = dbRead();
var targets = db.spyTargets && db.spyTargets[username] ? db.spyTargets[username] : {};
var now      = Date.now();
var oneMonth = 30 * 24 * 60 * 60 * 1000;

var list = Object.values(targets).map(function(t) {
return {
targetUser:     t.targetUser,
displayName:    t.displayName,
profilePic:     t.profilePic,
followingCount: (t.following || []).length,
recentFollows:  (t.recentFollows || []).filter(function(u) { return now - u.followedAt < oneMonth; }),
lastChecked:    t.lastChecked,
addedAt:        t.addedAt,
};
});

return res.json({ targets: list });
});

// ———————————————————––
//  ROUTE: DELETE /api/spy/remove/:target
// ———————————————————––
app.delete(”/api/spy/remove/:target”, function(req, res) {
var username = req.session.username;
if (!username) return res.status(401).json({ error: “Not logged in” });

var db = dbRead();
if (db.spyTargets && db.spyTargets[username]) {
delete db.spyTargets[username][req.params.target];
dbWrite(db);
}
return res.json({ success: true });
});

// ———————————————————––
//  CRON: auto-check all tracked accounts every 5 minutes
// ———————————————————––
cron.schedule(”*/5 * * * *”, async function() {
var db       = dbRead();
var accounts = Object.entries(db.accounts);

for (var i = 0; i < accounts.length; i++) {
var username = accounts[i][0];
var account  = accounts[i][1];

```
if (!account.tracking) continue;
if (syncLocks[username]) {
  log("cron", "@" + username + " sync already running, skipping");
  continue;
}

try {
  log("cron", "Checking @" + username);
  var r = await runSync(username);
  log("cron", "@" + username + ": " + r.followerCount + " followers | -" + r.newUnfollowers + " | +" + r.gained);
} catch (err) {
  log("cron", "@" + username + " error: " + err.message);
}

if (i < accounts.length - 1) await sleep(10000);
```

}
});

// ———————————————————––
//  START SERVER
// ———————————————————––
app.listen(PORT, function() {
console.log(”\n======================================”);
console.log(”  FollowWatch is running!”);
console.log(”  URL: http://localhost:” + PORT);
console.log(”  Proxy: “ + (PROXY_URL ? “enabled” : “disabled”));
console.log(”  Auto-sync: every 5 minutes”);
console.log(”======================================\n”);
});
