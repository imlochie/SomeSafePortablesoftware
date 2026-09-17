import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import app from "../src/app";
import { archiveDb, writeSettings } from "../src/lib/archive-db";

const owner = "__local__";

test("Power Renamer plans, approves, and creates a researched operation", async () => {
  const root = `/tmp/power-renamer-http-${Date.now()}`;
  writeSettings({ dataDirectory: "D:\\Tv Shows", downloadDirectory: "D:\\Tv Shows", temporaryDirectory: "D:\\Tv Shows", archiveDirectory: "D:\\Tv Shows" });
  const paths = ["D:\\Tv Shows\\Research Show\\Research Show S01E01.mkv", "D:\\Tv Shows\\Research Show\\Research Show S01E02.mkv"];
  const insertFile = archiveDb.prepare("INSERT INTO file_record (path, size_bytes, checksum, fingerprint, owner_id, filename, relative_path, scan_status, archive_root) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)");
  const ids = paths.map((path, index) => Number(insertFile.run(path, 100 + index, `checksum-${index}`, null, owner, path.split("\\").pop(), path, root).lastInsertRowid));
  const library = Number(archiveDb.prepare("INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id) VALUES (?, ?, ?, ?, ?)").run("Research TV", "http://plex.test", "research", "show", owner).lastInsertRowid);
  const insertPlex = archiveDb.prepare("INSERT INTO plex_item (library_id, rating_key, title, item_type, metadata_json, owner_id) VALUES (?, ?, ?, 'episode', ?, ?)");
  insertPlex.run(library, "research-1", "Episode 1", JSON.stringify({ grandparentTitle: "Research Show", parentIndex: 1, index: 1 }), owner);
  insertPlex.run(library, "research-2", "Episode 2", JSON.stringify({ grandparentTitle: "Research Show", parentIndex: 1, index: 2 }), owner);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  try {
    const planResponse = await request("/api/archive/power-renamer/plan", { method: "POST", body: JSON.stringify({ fileRecordIds: ids }) });
    assert.equal(planResponse.status, 201);
    const plan = await planResponse.json() as Record<string, any>;
    assert.equal(plan.summary.files, 2);
    assert.equal(plan.reviewState, "pending");
    assert.equal(plan.mappings.length, 2);
    const approval = await request(`/api/review-items/${plan.reviewItemId}/approve`, { method: "POST", body: "{}" });
    assert.equal(approval.status, 200);
    writeSettings({ dataDirectory: "D:\\Tv Shows", downloadDirectory: "D:\\Tv Shows", temporaryDirectory: "D:\\Tv Shows", archiveDirectory: "D:\\Tv Shows" });
    const operation = await request("/api/archive/power-renamer/operations", { method: "POST", body: JSON.stringify({ reviewItemId: plan.reviewItemId }) });
    const operationText = await operation.text();
    assert.equal(operation.status, 201, operationText);
    const operationBody = JSON.parse(operationText) as Record<string, any>;
    assert.equal(operationBody.batch.length, 2);
    assert.equal(operationBody.status, "planned");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    archiveDb.prepare("DELETE FROM plex_item WHERE owner_id = ?").run(owner);
    archiveDb.prepare("DELETE FROM plex_library WHERE owner_id = ?").run(owner);
    archiveDb.prepare("DELETE FROM file_record WHERE owner_id = ? AND id IN (?, ?)").run(owner, ids[0], ids[1]);
  }
});
