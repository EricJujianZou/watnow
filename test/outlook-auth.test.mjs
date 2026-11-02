import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Minimal chrome stub: in-memory storage, a scripted sign-in window, recorded DNR rules.
const local = new Map();
const session = new Map();
const area = (map) => ({
  get: async (key) => (map.has(key) ? { [key]: structuredClone(map.get(key)) } : {}),
  set: async (items) => {
    for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v));
  },
  remove: async (key) => {
    map.delete(key);
  },
});
let sessionRules = new Map();
let ruleCalls = [];
let launch = async () => {
  throw new Error("no flow scripted");
};
let launched = [];

globalThis.chrome = {
  runtime: {
    id: "test-extension-id",
    getURL: (path = "") => `chrome-extension://test-extension-id/${path}`,
  },
  storage: { local: area(local), session: area(session) },
  identity: {
    getRedirectURL: (name = "") => `https://test-extension-id.chromiumapp.org/${name}`,
    launchWebAuthFlow: async (opts) => {
      launched.push(opts);
      return launch(opts);
    },
  },
  declarativeNetRequest: {
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
      ruleCalls.push({ removeRuleIds, addRules });
      for (const id of removeRuleIds) sessionRules.delete(id);
      for (const r of addRules) sessionRules.set(r.id, r);
    },
  },
};

// Scripted fetch: token endpoint and Graph /me.
let tokenReplies = [];
let tokenBodies = [];
let meReply = { status: 200, body: { id: "ms-1", displayName: "Ada L", mail: null, userPrincipalName: "ada@uwaterloo.ca" } };
let meCalls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://login.microsoftonline.com/common/oauth2/v2.0/token")) {
    tokenBodies.push(Object.fromEntries(new URLSearchParams(init.body)));
    const next = tokenReplies.shift();
    if (!next) throw new Error("unexpected token request");
    if (next instanceof Error) throw next;
    return json(next.status ?? 200, next.body);
  }
  if (url.startsWith("https://graph.microsoft.com/v1.0/me")) {
    meCalls.push({ url, auth: init.headers?.Authorization });
    return json(meReply.status, meReply.body);
  }
  throw new Error(`unexpected fetch ${url}`);
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const auth = await import("../extension/src/calendar/outlook-auth.js");
const { connectOutlook, getOutlookToken, disconnectOutlook, invalidateOutlookToken, ensureOriginRule, outlookRedirectUrl, __testing } = auth;

const REDIRECT = "https://test-extension-id.chromiumapp.org/outlook";
const tokens = (n, extra = {}) => ({
  token_type: "Bearer",
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: 3600,
  scope: "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read",
  ...extra,
});
/** Signs in by echoing the request's state back with a code. */
const approve = (extra = "") => async ({ url }) => {
  const state = new URL(url).searchParams.get("state");
  return `${REDIRECT}?code=the-code&state=${state}${extra}`;
};

beforeEach(() => {
  __testing.reset();
  __testing.setClientId("client-123");
  local.clear();
  session.clear();
  sessionRules = new Map();
  ruleCalls = [];
  launched = [];
  tokenReplies = [];
  tokenBodies = [];
  meCalls = [];
  meReply = { status: 200, body: { id: "ms-1", displayName: "Ada L", mail: null, userPrincipalName: "ada@uwaterloo.ca" } };
  launch = approve();
});

async function connected() {
  tokenReplies.push({ body: tokens(1) });
  return (await connectOutlook({ email: "ada@uwaterloo.ca" })).account;
}

test("redirect URL is the identity URL for 'outlook'", () => {
  assert.equal(outlookRedirectUrl(), REDIRECT);
});

test("authorize URL carries login_hint, state and a matching S256 challenge; code exchange uses the verifier", async () => {
  await connected();
  assert.equal(launched.length, 1);
  assert.equal(launched[0].interactive, true);
  const url = new URL(launched[0].url);
  assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  const p = url.searchParams;
  assert.equal(p.get("client_id"), "client-123");
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("response_mode"), "query");
  assert.equal(p.get("redirect_uri"), REDIRECT);
  assert.equal(p.get("scope"), "Calendars.ReadWrite User.Read offline_access");
  assert.equal(p.get("login_hint"), "ada@uwaterloo.ca");
  assert.equal(p.get("prompt"), "select_account");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.ok(p.get("state") && p.get("state").length >= 16);

  assert.equal(tokenBodies.length, 1);
  const body = tokenBodies[0];
  assert.deepEqual(
    { grant_type: body.grant_type, code: body.code, redirect_uri: body.redirect_uri, client_id: body.client_id, scope: body.scope },
    { grant_type: "authorization_code", code: "the-code", redirect_uri: REDIRECT, client_id: "client-123", scope: "Calendars.ReadWrite User.Read offline_access" },
  );
  assert.ok(!("client_secret" in body));
  assert.match(body.code_verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const expected = createHash("sha256").update(body.code_verifier).digest("base64url");
  assert.equal(p.get("code_challenge"), expected);
});

test("connect returns the /me account and saves the refresh token locally, access token in session", async () => {
  const account = await connected();
  assert.deepEqual(account, { id: "ms-1", email: "ada@uwaterloo.ca", name: "Ada L" });
  assert.equal(meCalls.length, 1);
  assert.equal(meCalls[0].url, "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName");
  assert.equal(meCalls[0].auth, "Bearer access-1");
  const saved = local.get("outlookAuth");
  assert.equal(saved.refreshToken, "refresh-1");
  assert.deepEqual(saved.account, account);
  assert.ok(saved.scope.includes("Calendars.ReadWrite"));
  assert.equal(session.get("outlookToken").token, "access-1");
  assert.equal(session.get("outlookToken").accountId, "ms-1");
});

test("mail wins over userPrincipalName when present", async () => {
  meReply = { status: 200, body: { id: "ms-2", displayName: "Bo", mail: "bo@outlook.com", userPrincipalName: "bo_outlook.com#EXT#@x" } };
  const account = await connected();
  assert.equal(account.email, "bo@outlook.com");
});

test("a response with the wrong state is rejected before any token request", async () => {
  launch = async () => `${REDIRECT}?code=the-code&state=forged`;
  await assert.rejects(connectOutlook({ email: "a@b.ca" }), (e) => e.code === "auth");
  assert.equal(tokenBodies.length, 0);
  assert.equal(local.has("outlookAuth"), false);
});

test("closing the sign-in window is 'cancelled' (Chrome and Firefox wording)", async () => {
  launch = async () => {
    throw new Error("The user did not approve access.");
  };
  await assert.rejects(connectOutlook({ email: "a@b.ca" }), (e) => e.code === "cancelled");
  launch = async () => {
    throw new Error("User cancelled or denied access.");
  };
  await assert.rejects(connectOutlook({ email: "a@b.ca" }), (e) => e.code === "cancelled");
});

test("another sign-in window already open has its own message", async () => {
  launch = async () => {
    throw new Error("Only one web auth flow can be active at a time.");
  };
  await assert.rejects(connectOutlook({ email: "a@b.ca" }), (e) => e.code === "auth" && /already open/.test(e.message));
});

test("a missing client ID is a configuration error and opens no window", async () => {
  __testing.setClientId("");
  await assert.rejects(
    connectOutlook({ email: "a@b.ca" }),
    (e) => e.code === "configuration" && e.message === "Outlook sync isn't set up in this version of WATnow.",
  );
  assert.equal(launched.length, 0);
});

test("admin approval needed (redirect error) explains what to do", async () => {
  launch = async ({ url }) => {
    const state = new URL(url).searchParams.get("state");
    return `${REDIRECT}?error=access_denied&error_description=${encodeURIComponent("AADSTS90094: Admin approval required.")}&state=${state}`;
  };
  await assert.rejects(connectOutlook({ email: "a@uwaterloo.ca" }), (e) => e.code === "auth" && /administrator's approval/.test(e.message));
});

test("consent_required from the token endpoint explains what to do", async () => {
  tokenReplies.push({ status: 400, body: { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented." } });
  await assert.rejects(connectOutlook({ email: "a@uwaterloo.ca" }), (e) => e.code === "auth" && /administrator's approval/.test(e.message));
  tokenReplies.push({ status: 400, body: { error: "consent_required" } });
  await assert.rejects(connectOutlook({ email: "a@uwaterloo.ca" }), (e) => /administrator's approval/.test(e.message));
});

test("a cached access token is reused without a token request", async () => {
  const account = await connected();
  assert.equal(await getOutlookToken(account), "access-1");
  assert.equal(tokenBodies.length, 1);
});

test("the session token survives a service-worker restart (memory lost)", async () => {
  const account = await connected();
  const saved = new Map(session);
  __testing.reset();
  __testing.setClientId("client-123");
  for (const [k, v] of saved) session.set(k, v);
  assert.equal(await getOutlookToken(account), "access-1");
  assert.equal(tokenBodies.length, 1);
});

test("near expiry it refreshes and saves the rotated refresh token", async () => {
  const account = await connected();
  const near = { ...session.get("outlookToken"), expiresAt: Date.now() + 60 * 1000 };
  __testing.reset();
  __testing.setClientId("client-123");
  session.set("outlookToken", near);
  tokenReplies.push({ body: tokens(2) });
  assert.equal(await getOutlookToken(account), "access-2");
  const body = tokenBodies.at(-1);
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, "refresh-1");
  assert.equal(body.client_id, "client-123");
  assert.equal(local.get("outlookAuth").refreshToken, "refresh-2");
  assert.equal(session.get("outlookToken").token, "access-2");
});

test("concurrent callers share one refresh", async () => {
  const account = await connected();
  await invalidateOutlookToken();
  tokenReplies.push({ body: tokens(2) });
  const [a, b] = await Promise.all([getOutlookToken(account), getOutlookToken(account)]);
  assert.equal(a, "access-2");
  assert.equal(b, "access-2");
  assert.equal(tokenBodies.length, 2);
});

test("invalidateOutlookToken drops the access token but keeps the refresh token", async () => {
  const account = await connected();
  await invalidateOutlookToken();
  assert.equal(session.has("outlookToken"), false);
  assert.equal(local.get("outlookAuth").refreshToken, "refresh-1");
  tokenReplies.push({ body: tokens(2) });
  assert.equal(await getOutlookToken(account), "access-2");
  assert.equal(tokenBodies.at(-1).grant_type, "refresh_token");
});

test("invalid_grant on refresh asks to sign in again and is not retryable", async () => {
  const account = await connected();
  await invalidateOutlookToken();
  tokenReplies.push({ status: 400, body: { error: "invalid_grant", error_description: "AADSTS70008: The refresh token has expired." } });
  await assert.rejects(getOutlookToken(account), (e) => e.code === "auth" && e.message === "Sign in to Outlook again to keep syncing." && !e.retry);
});

test("network failures and 5xx/429 on refresh are retryable", async () => {
  const account = await connected();
  await invalidateOutlookToken();
  tokenReplies.push(new TypeError("Failed to fetch"));
  await assert.rejects(getOutlookToken(account), (e) => e.code === "network" && e.retry === true);
  tokenReplies.push({ status: 503, body: {} });
  await assert.rejects(getOutlookToken(account), (e) => e.retry === true);
  tokenReplies.push({ status: 429, body: {} });
  await assert.rejects(getOutlookToken(account), (e) => e.retry === true);
  assert.equal(local.get("outlookAuth").refreshToken, "refresh-1");
});

test("a different account than the stored one must sign in again", async () => {
  await connected();
  await assert.rejects(
    getOutlookToken({ id: "someone-else", email: "x@y.ca" }),
    (e) => e.code === "auth" && e.message === "Sign in to Outlook again to keep syncing.",
  );
});

test("disconnect clears memory, session, local storage and the DNR rule", async () => {
  const account = await connected();
  assert.ok(sessionRules.has(4242));
  await disconnectOutlook();
  assert.equal(local.has("outlookAuth"), false);
  assert.equal(session.has("outlookToken"), false);
  assert.equal(sessionRules.has(4242), false);
  await assert.rejects(getOutlookToken(account), (e) => e.code === "auth");
  assert.equal(tokenBodies.length, 1);
});

test("Origin rule strips the header only for this extension's token requests", async () => {
  await ensureOriginRule();
  const call = ruleCalls.at(-1);
  assert.deepEqual(call.removeRuleIds, [4242]);
  assert.equal(call.addRules.length, 1);
  const rule = call.addRules[0];
  assert.equal(rule.id, 4242);
  assert.deepEqual(rule.action, { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] });
  assert.deepEqual(rule.condition.initiatorDomains, ["test-extension-id"]);
  assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest", "other"]);
  const re = new RegExp(rule.condition.regexFilter);
  assert.ok(re.test("https://login.microsoftonline.com/common/oauth2/v2.0/token"));
  assert.ok(!re.test("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"));
  assert.ok(!re.test("https://evil.example/login.microsoftonline.com/common/oauth2/v2.0/token"));
});

test("the Origin rule is installed before the code is redeemed, and a missing DNR API is tolerated", async () => {
  await connected();
  assert.ok(ruleCalls.length >= 1);
  const dnr = chrome.declarativeNetRequest;
  delete chrome.declarativeNetRequest;
  try {
    await ensureOriginRule();
    await disconnectOutlook();
    tokenReplies.push({ body: tokens(3) });
    const account = (await connectOutlook({ email: "ada@uwaterloo.ca" })).account;
    assert.equal(account.id, "ms-1");
  } finally {
    chrome.declarativeNetRequest = dnr;
  }
});

test("tokens never reach the console", async () => {
  const logged = [];
  const orig = { warn: console.warn, log: console.log, error: console.error };
  console.warn = console.log = console.error = (...a) => logged.push(a.join(" "));
  try {
    const account = await connected();
    await invalidateOutlookToken();
    tokenReplies.push({ status: 400, body: { error: "invalid_client", error_description: "AADSTS7000218: bad client" } });
    await assert.rejects(getOutlookToken(account), (e) => e.code === "configuration");
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(logged.every((l) => !/access-|refresh-|the-code/.test(l)));
});
