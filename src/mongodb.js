'use strict';

const { MongoClient } = require('mongodb');

let client;
let connection;

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

module.exports = { connectMongo };