// Seeded music database (node:sqlite, Node >= 22.5) and the three SQL tools
// the agent uses: list_tables, get_schema, run_query (read-only).
//
// Tools are plain ToolDefs — data the model can call by name. They close over
// the DatabaseSync handle, which is why they live in world *resources*
// (registerTools), never in components.

import { DatabaseSync } from 'node:sqlite';
import { defineTool, type ToolDef } from '@langecs/stdlib';

const SCHEMA = `
CREATE TABLE artists (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE albums (
  id        INTEGER PRIMARY KEY,
  title     TEXT NOT NULL,
  artist_id INTEGER NOT NULL REFERENCES artists(id)
);
CREATE TABLE tracks (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  album_id    INTEGER NOT NULL REFERENCES albums(id),
  duration_ms INTEGER NOT NULL
);
`;

const ARTISTS: [number, string][] = [
  [1, 'Pink Floyd'],
  [2, 'Radiohead'],
  [3, 'Miles Davis'],
];

const ALBUMS: [number, string, number][] = [
  [1, 'The Dark Side of the Moon', 1],
  [2, 'Wish You Were Here', 1],
  [3, 'OK Computer', 2],
  [4, 'Kid A', 2],
  [5, 'Kind of Blue', 3],
];

const TRACKS: [number, string, number, number][] = [
  [1, 'Breathe', 1, 163000],
  [2, 'Time', 1, 421000],
  [3, 'Money', 1, 382000],
  [4, 'Us and Them', 1, 462000],
  [5, 'Shine On You Crazy Diamond, Pt. 1', 2, 811000],
  [6, 'Wish You Were Here', 2, 334000],
  [7, 'Paranoid Android', 3, 387000],
  [8, 'Karma Police', 3, 261000],
  [9, 'No Surprises', 3, 229000],
  [10, 'Lucky', 3, 259000],
  [11, 'Everything in Its Right Place', 4, 251000],
  [12, 'How to Disappear Completely', 4, 356000],
  [13, 'Idioteque', 4, 309000],
  [14, 'So What', 5, 562000],
  [15, 'Blue in Green', 5, 337000],
  [16, 'All Blues', 5, 693000],
];

/** In-memory SQLite database with 3 seeded tables: artists, albums, tracks. */
export function createMusicDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const insertArtist = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)');
  for (const row of ARTISTS) insertArtist.run(...row);
  const insertAlbum = db.prepare('INSERT INTO albums (id, title, artist_id) VALUES (?, ?, ?)');
  for (const row of ALBUMS) insertAlbum.run(...row);
  const insertTrack = db.prepare(
    'INSERT INTO tracks (id, name, album_id, duration_ms) VALUES (?, ?, ?, ?)',
  );
  for (const row of TRACKS) insertTrack.run(...row);
  return db;
}

const MAX_ROWS = 50;

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * The agent's toolbox. Thrown errors become `Error: ...` tool messages
 * (stdlib executeTools), so the model can read the failure and retry —
 * the same contract as LangGraph's sql_db_query tool.
 */
export function createSqlTools(db: DatabaseSync): ToolDef[] {
  const listTables = defineTool({
    name: 'list_tables',
    description: 'Lists the tables in the database as a comma-separated string. Takes no input.',
    parameters: { type: 'object', properties: {} },
    execute: () => tableNames(db).join(', '),
  });

  const getSchema = defineTool({
    name: 'get_schema',
    description:
      'Returns the CREATE TABLE statement and 3 sample rows for each requested table. ' +
      'Input is a comma-separated list of table names; call list_tables first to see what exists.',
    parameters: {
      type: 'object',
      properties: {
        tables: {
          type: 'string',
          description: 'Comma-separated table names, e.g. "artists, tracks"',
        },
      },
      required: ['tables'],
    },
    execute: (args) => {
      const { tables } = args as { tables: string };
      const known = new Set(tableNames(db));
      const parts: string[] = [];
      for (const raw of tables.split(',')) {
        const table = raw.trim();
        if (table.length === 0) continue;
        if (!known.has(table)) {
          throw new Error(`unknown table "${table}". Available tables: ${[...known].join(', ')}`);
        }
        const ddl = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { sql: string };
        // `table` is validated against sqlite_master above, so interpolation is safe.
        const sample = db.prepare(`SELECT * FROM ${table} LIMIT 3`).all();
        parts.push(`${ddl.sql.trim()}\n/* sample rows */\n${JSON.stringify(sample)}`);
      }
      return parts.join('\n\n');
    },
  });

  const runQuery = defineTool({
    name: 'run_query',
    description:
      'Executes a single read-only SELECT statement and returns the rows as JSON. ' +
      'Anything else (INSERT/UPDATE/DELETE/DROP/PRAGMA/multiple statements) is rejected. ' +
      'If an error is returned, rewrite the query and try again.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A single SELECT statement' } },
      required: ['query'],
    },
    execute: (args) => {
      const { query } = args as { query: string };
      const sql = query.trim().replace(/;\s*$/, '');
      if (!/^select\b/i.test(sql) || sql.includes(';')) {
        throw new Error('run_query is read-only: a single SELECT statement is required.');
      }
      const rows = db.prepare(sql).all();
      return JSON.stringify(rows.slice(0, MAX_ROWS));
    },
  });

  return [listTables, getSchema, runQuery];
}
