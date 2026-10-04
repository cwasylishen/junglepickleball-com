// Glow in the Dark tournament signup: pure-logic probes against the real
// module (no wrangler dev, no network) with a tiny in-memory KV mock that
// mirrors the EVENTS namespace's get/put/delete shape.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validGlowInput,
  createGlowSignup,
  getGlowSignups,
  deleteGlowSignup,
  handleGlowSignup,
  handleGlowList,
} from "../../src/worker.js";

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

test("validGlowInput requires name, phone and a valid role", () => {
  assert.equal(validGlowInput({ name: "", phone: "1", role: "player" }), "Name is required.");
  assert.equal(validGlowInput({ name: "A", phone: "", role: "player" }), "A phone or WhatsApp number is required.");
  assert.equal(validGlowInput({ name: "A", phone: "1", role: "dancer" }), "Role must be player or spectator.");
  assert.equal(validGlowInput({ name: "A", phone: "1", role: "spectator" }), null);
});

test("createGlowSignup appends one row and defaults people to 1", async () => {
  const env = { EVENTS: makeKv() };
  const s = await createGlowSignup(env, { name: "Pat", phone: "8989", role: "player" });
  assert.equal(s.people, 1);
  assert.equal(s.spectatorMeal, false);
  const list = await getGlowSignups(env);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, s.id);
});

test("createGlowSignup ignores spectatorMeal for players, keeps it for spectators", async () => {
  const env = { EVENTS: makeKv() };
  const player = await createGlowSignup(env, { name: "P", phone: "1", role: "player", spectatorMeal: true });
  assert.equal(player.spectatorMeal, false);
  const spectator = await createGlowSignup(env, { name: "S", phone: "2", role: "spectator", spectatorMeal: true });
  assert.equal(spectator.spectatorMeal, true);
});

test("deleteGlowSignup removes exactly one row by id and is repeatable (run-it-twice)", async () => {
  const env = { EVENTS: makeKv() };
  const a = await createGlowSignup(env, { name: "A", phone: "1", role: "player" });
  await createGlowSignup(env, { name: "B", phone: "2", role: "spectator" });
  const first = await deleteGlowSignup(env, a.id);
  assert.equal(first, true);
  assert.equal((await getGlowSignups(env)).length, 1);
  // Running the same deletion again leaves the same state: no row to
  // remove, reports false, and the surviving row count is unchanged.
  const second = await deleteGlowSignup(env, a.id);
  assert.equal(second, false);
  assert.equal((await getGlowSignups(env)).length, 1);
});

test("handleGlowSignup honeypot returns a fake success and writes nothing", async () => {
  const env = { EVENTS: makeKv() };
  const req = new Request("https://x/api/glow/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": "9.9.9.9", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Bot", phone: "0", role: "player", website: "http://spam.example" }),
  });
  const res = await handleGlowSignup(req, env);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal((await getGlowSignups(env)).length, 0);
});

test("handleGlowSignup rejects invalid input with a 400 and the specific reason", async () => {
  const env = { EVENTS: makeKv() };
  const req = new Request("https://x/api/glow/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": "1.2.3.4", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", phone: "", role: "player" }),
  });
  const res = await handleGlowSignup(req, env);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "Name is required.");
});

test("handleGlowSignup rate-limits a connection after 5 attempts in the window", async () => {
  const env = { EVENTS: makeKv() };
  const ip = "5.5.5.5";
  for (let i = 0; i < 5; i++) {
    const req = new Request("https://x/api/glow/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `N${i}`, phone: "1", role: "player" }),
    });
    const res = await handleGlowSignup(req, env);
    assert.equal(res.status, 201);
  }
  const req = new Request("https://x/api/glow/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Overflow", phone: "1", role: "player" }),
  });
  const res = await handleGlowSignup(req, env);
  assert.equal(res.status, 429);
});

test("handleGlowList requires the key and reports counts correctly", async () => {
  const env = { EVENTS: makeKv(), GLOW_LIST_KEY: "sekret" };
  await createGlowSignup(env, { name: "A", phone: "1", role: "player" });
  await createGlowSignup(env, { name: "B", phone: "2", role: "spectator", spectatorMeal: true, people: 2 });

  const denied = await handleGlowList(new Request("https://x/api/glow/list"), env, new URL("https://x/api/glow/list"));
  assert.equal(denied.status, 401);

  const url = new URL("https://x/api/glow/list?key=sekret");
  const ok = await handleGlowList(new Request(url), env, url);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.counts.players, 1);
  assert.equal(body.counts.spectators, 1);
  assert.equal(body.counts.spectatorMeals, 1);
  assert.equal(body.counts.totalPeople, 3);
});

test("handleGlowList 503s when GLOW_LIST_KEY is not configured yet", async () => {
  const env = { EVENTS: makeKv() };
  const url = new URL("https://x/api/glow/list?key=anything");
  const res = await handleGlowList(new Request(url), env, url);
  assert.equal(res.status, 503);
});
