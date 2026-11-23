import { test } from "node:test";
import assert from "node:assert/strict";
import { loginDemo, BASE_URL } from "./foundation/helpers.mjs";

const futureDate = "2099-12-19";

function headers(csrf) {
  return { Origin: BASE_URL, "X-CSRF-Token": csrf };
}

test("owner event CRUD publishes to the public feed, while a member cannot write", async () => {
  const owner = await loginDemo("owner.demo@jp-demo.test");
  const member = await loginDemo("member.demo@jp-demo.test");
  const body = {
    title: "QA event CRUD",
    event_date: futureDate,
    event_time: "5:00 PM to 8:00 PM",
    place: "Jungle Pickleball, Ojochal",
    description: "A temporary event used to test the owner editor.",
    price_text: "Preview sample only",
    status: "draft",
  };

  const refused = await member.client.post("/api/portal/owner/events", body, headers(member.csrfToken));
  assert.deepEqual([refused.status, refused.data.error], [403, "owner_only"]);

  const created = await owner.client.post("/api/portal/owner/events", body, headers(owner.csrfToken));
  assert.equal(created.status, 201);
  assert.equal(created.data.title, body.title);
  const id = created.data.id;

  try {
    const listed = await owner.client.get("/api/portal/owner/events");
    assert.equal(listed.status, 200);
    assert.equal(listed.data.some(event => event.id === id && event.status === "draft"), true);

    const invalid = await owner.client.request("PATCH", `/api/portal/owner/events/${id}`, { ...body, signup_url: "javascript:alert(1)" }, headers(owner.csrfToken));
    assert.deepEqual([invalid.status, invalid.data.error], [400, "signup_link_invalid"]);

    const published = await owner.client.request("PATCH", `/api/portal/owner/events/${id}`, { ...body, status: "published" }, headers(owner.csrfToken));
    assert.deepEqual([published.status, published.data.status], [200, "published"]);

    const publicResponse = await fetch(`${BASE_URL}/api/public/events`);
    const publicData = await publicResponse.json();
    assert.equal(publicResponse.status, 200);
    assert.equal(publicData.events.some(event => event.id === id && event.title === body.title), true);

    const deleted = await owner.client.request("DELETE", `/api/portal/owner/events/${id}`, undefined, headers(owner.csrfToken));
    assert.deepEqual([deleted.status, deleted.data.ok], [200, true]);
    const missing = await owner.client.get(`/api/portal/owner/events/${id}`);
    assert.deepEqual([missing.status, missing.data.error], [404, "not_found"]);
  } finally {
    await owner.client.request("DELETE", `/api/portal/owner/events/${id}`, undefined, headers(owner.csrfToken));
  }
});

test("public events feed excludes drafts and past events", async () => {
  const response = await fetch(`${BASE_URL}/api/public/events`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Array.isArray(data.events), true);
  assert.equal(data.events.every(event => event.date >= new Date().toISOString().slice(0, 10)), true);
  assert.equal(data.events.every(event => !event.status), true, "public shape does not expose editorial status");
});
