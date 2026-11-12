'use strict';

const fs = require('node:fs');
const { MongoClient } = require('mongodb');

let client;
let connection;
let persistQueue = Promise.resolve();

async function connectMongo() {
  if (!process.env.MONGODB_URI) return null;
  if (connection) return connection;

  client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 5,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  connection = client.db(process.env.MONGODB_DB || 'school_management');
  console.log('MongoDB Atlas connection established.');
  return connection;
}

async function restoreSqliteSnapshot() {
  if (!connection) return null;
  const row = await connection.collection('sqlite_snapshots').findOne({ _id: 'school_management' });
  return row ? Buffer.from(row.data.buffer || row.data) : null;
}

function queueSqliteSnapshot(dbPath) {
  if (!connection) return Promise.resolve();
  persistQueue = persistQueue.then(async () => {
    const data = fs.readFileSync(dbPath);
    await connection.collection('sqlite_snapshots').replaceOne(
      { _id: 'school_management' },
      { _id: 'school_management', data, updatedAt: new Date() },
      { upsert: true },
    );
  }).catch((err) => console.error(`MongoDB SQLite snapshot failed: ${err.message}`));
  return persistQueue;
}

module.exports = { connectMongo, restoreSqliteSnapshot, queueSqliteSnapshot };