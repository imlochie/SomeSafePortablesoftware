import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dbPath = process.env.ARCHIVE_DB_PATH ?? "data/archive-assistant.sqlite";
const backupPath = "data/archive-assistant.sqlite.before-tv-identity-refresh.bak";
const ownerId = "__local__";
const expected = {
  files: 37_721,
  plexItems: 35_890,
  identities: 26_713,
  tvKeys: 24_682,
  safeIdentityRows: 6_880,
  safeFiles: 6_930,
  inPlaceRows: 6_856,
  mergeSources: 24,
  ambiguousRows: 416,
};

function normalizeTitle(value) {
  const normalized = value
    .replace(/\.[^.]+$/, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\b(4k|uhd|2160p?|1080p?|720p?|480p?|bluray|web[ ._-]?dl|x26[45]|h26[45]|hevc|av1)\b/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized) return normalized;
  const year = value.match(/\b((?:19|20)\d{2})\b/);
  return year?.[1] ?? "";
}

function localEpisodeIdentity(filename) {
  const name = filename.replace(/\.[^.]+$/, "");
  const match = name.match(/^(.+?)[\s._-]+(?:S(\d{1,2})[\s._-]*E(\d{1,2})|(\d{1,2})x(\d{1,2}))(?=E\d{1,2}(?:[\s._-]|$)|[\s._-]|$)/i);
  if (!match) return null;
  const show = normalizeTitle(`${match[1]}.mkv`);
  const season = Number(match[2] ?? match[4]);
  const episode = Number(match[3] ?? match[5]);
  return show && Number.isInteger(season) && Number.isInteger(episode)
    ? { show, season, episode }
    : null;
}

function queryOne(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function queryAll(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function signature(rows, fields) {
  return JSON.stringify(rows.map((row) => fields.map((field) => row[field])));
}

function discover(db) {
  const identities = queryAll(db, `
    SELECT id, owner_id, identity_key, media_type, normalized_title, year,
           show_identity, season_number, episode_number
    FROM local_media_identity
    WHERE owner_id = ?
    ORDER BY id
  `, ownerId);
  const files = queryAll(db, `
    SELECT id, path, filename, local_identity_id
    FROM file_record
    WHERE owner_id = ?
    ORDER BY id
  `, ownerId);
  const byIdentity = new Map();
  for (const file of files) {
    if (file.local_identity_id === null) continue;
    const attached = byIdentity.get(file.local_identity_id) ?? [];
    attached.push(file);
    byIdentity.set(file.local_identity_id, attached);
  }
  const identityByKey = new Map(identities.map((identity) => [identity.identity_key, identity]));
  const safe = [];
  const ambiguous = [];
  for (const identity of identities) {
    if (identity.media_type !== "tv" || !identity.identity_key.startsWith("tv:")) continue;
    const attached = byIdentity.get(identity.id) ?? [];
    if (!attached.length || attached.some((file) => !/(?:^|[\\/])tv shows?(?:[\\/]|$)/i.test(file.path))) continue;
    const parsed = attached.map((file) => localEpisodeIdentity(file.filename));
    if (parsed.some((value) => value === null)) continue;
    const targets = new Set(parsed.map((value) => `tv:${value.show}:${value.season}:${value.episode}`));
    if (targets.size > 1) {
      ambiguous.push(identity);
      continue;
    }
    const targetKey = [...targets][0];
    if (targetKey === identity.identity_key) continue;
    const target = identityByKey.get(targetKey);
    safe.push({ identity, files: attached, parsed: parsed[0], target });
  }
  const mergeSources = safe.filter((item) => item.target && item.target.id !== item.identity.id);
  const inPlace = safe.filter((item) => !item.target);
  return { identities, files, safe, ambiguous, mergeSources, inPlace };
}

function baseline(db) {
  return {
    files: queryOne(db, "SELECT COUNT(*) AS count FROM file_record").count,
    plexItems: queryOne(db, "SELECT COUNT(*) AS count FROM plex_item").count,
    identities: queryOne(db, "SELECT COUNT(*) AS count FROM local_media_identity").count,
    tvKeys: queryOne(db, "SELECT COUNT(*) AS count FROM local_media_identity WHERE owner_id = ? AND identity_key LIKE 'tv:%'", ownerId).count,
    orphans: queryOne(db, `
      SELECT COUNT(*) AS count
      FROM file_record f
      LEFT JOIN local_media_identity i ON i.id = f.local_identity_id
      WHERE f.owner_id = ? AND f.local_identity_id IS NOT NULL AND i.id IS NULL
    `, ownerId).count,
  };
}

function assertBaseline(db) {
  const counts = baseline(db);
  for (const [key, value] of Object.entries(expected)) {
    if (key in counts && counts[key] !== value) {
      throw new Error(`Database baseline mismatch for ${key}: expected ${value}, got ${counts[key]}`);
    }
  }
  if (!existsSync(backupPath)) throw new Error(`Rollback backup is missing: ${backupPath}`);
  return counts;
}

function assertDiscovery(discovery) {
  const actual = {
    safeIdentityRows: discovery.safe.length,
    safeFiles: discovery.safe.reduce((count, item) => count + item.files.length, 0),
    inPlaceRows: discovery.inPlace.length,
    mergeSources: discovery.mergeSources.length,
    ambiguousRows: discovery.ambiguous.length,
  };
  for (const [key, value] of Object.entries(actual)) {
    if (value !== expected[key]) throw new Error(`Safe-set mismatch for ${key}: expected ${expected[key]}, got ${value}`);
  }
  return actual;
}

function verify(db, before, discovery) {
  const after = baseline(db);
  if (after.files !== before.files) throw new Error("file_record count changed");
  if (after.plexItems !== before.plexItems) throw new Error("plex_item count changed");
  if (after.identities !== before.identities - expected.mergeSources) throw new Error("identity count changed unexpectedly");
  if (after.tvKeys !== before.tvKeys - expected.mergeSources) throw new Error("TV identity count changed unexpectedly");

  if (after.orphans !== before.orphans) throw new Error(`Orphaned file identity references changed from ${before.orphans} to ${after.orphans}`);
  const duplicate = queryOne(db, `
    SELECT COUNT(*) AS count
    FROM (
      SELECT owner_id, identity_key
      FROM local_media_identity
      GROUP BY owner_id, identity_key
      HAVING COUNT(*) > 1
    )
  `).count;
  if (duplicate !== 0) throw new Error(`Duplicate identity keys: ${duplicate}`);

  for (const item of discovery.safe) {
    const targetKey = `tv:${item.parsed.show}:${item.parsed.season}:${item.parsed.episode}`;
    const target = queryOne(db, "SELECT * FROM local_media_identity WHERE owner_id = ? AND identity_key = ?", ownerId, targetKey);
    if (!target) throw new Error(`Missing repaired target identity: ${targetKey}`);
    if (item.target && queryOne(db, "SELECT 1 AS present FROM local_media_identity WHERE id = ?", item.identity.id)) {
      throw new Error(`Merged source identity remains: ${item.identity.id}`);
    }
    if (!item.target && (target.show_identity !== item.parsed.show || target.season_number !== item.parsed.season || target.episode_number !== item.parsed.episode)) {
      throw new Error(`In-place identity fields are incorrect: ${targetKey}`);
    }
    const attached = queryOne(db, "SELECT COUNT(*) AS count FROM file_record WHERE owner_id = ? AND local_identity_id = ?", ownerId, target.id).count;
    if (attached < item.files.length) throw new Error(`Repaired files missing from target: ${targetKey}`);
  }
}

const db = new DatabaseSync(dbPath);
try {
  const before = assertBaseline(db);
  const discovery = discover(db);
  const safeSet = assertDiscovery(discovery);
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify({ dryRun: true, before, ...safeSet }, null, 2));
  } else {
    db.exec("BEGIN IMMEDIATE");
    try {
      const update = db.prepare(`
        UPDATE local_media_identity
        SET identity_key = ?, normalized_title = ?, show_identity = ?,
            season_number = ?, episode_number = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_id = ?
      `);
      const repoint = db.prepare("UPDATE file_record SET local_identity_id = ? WHERE owner_id = ? AND local_identity_id = ?");
      const remove = db.prepare("DELETE FROM local_media_identity WHERE id = ? AND owner_id = ?");
      for (const item of discovery.safe) {
        const targetKey = `tv:${item.parsed.show}:${item.parsed.season}:${item.parsed.episode}`;
        if (item.target) {
          repoint.run(item.target.id, ownerId, item.identity.id);
          remove.run(item.identity.id, ownerId);
        } else {
          update.run(targetKey, item.parsed.show, item.parsed.show, item.parsed.season, item.parsed.episode, item.identity.id, ownerId);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    verify(db, before, discovery);
    console.log(JSON.stringify({ applied: true, before, ...safeSet, after: baseline(db) }, null, 2));
  }
} finally {
  db.close();
}
