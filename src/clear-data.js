'use strict';

/* Removes all application data except the named headmaster account. */
require('dotenv').config({ quiet: true });

const { connect, close, col, COLLECTIONS } = require('./db');

async function clearData() {
  await connect();
  const headmaster = await col('users').findOne({ username: 'headmaster', role: 'headmaster' });
  if (!headmaster) throw new Error('The headmaster account was not found; no data was changed.');

  for (const name of COLLECTIONS) {
    if (name === 'users') await col(name).deleteMany({ _id: { $ne: headmaster._id } });
    else await col(name).deleteMany({});
  }

  // Keep future user IDs higher than the preserved account's ID.
  await col('counters').updateOne({ _id: 'users' }, { $set: { seq: headmaster.id } }, { upsert: true });

  const users = await col('users').find({}, { projection: { _id: 0, username: 1, role: 1 } }).toArray();
  const records = await Promise.all(
    COLLECTIONS.filter((name) => !['users', 'counters'].includes(name)).map((name) => col(name).countDocuments()),
  );
  if (users.length !== 1 || users[0].username !== 'headmaster' || records.some(Boolean)) {
    throw new Error('Data clear verification failed.');
  }
  console.log('All records were removed except the headmaster account.');
}

clearData()
  .catch((err) => {
    console.error(`Data clear failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(close);
