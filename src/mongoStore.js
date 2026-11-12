'use strict';

const { col, nextId, withTransaction } = require('./db');

async function insertWithId(name, document, session) {
  const value = { ...document };
  if (value.id == null) value.id = await nextId(name, session);
  await col(name).insertOne(value, { session });
  return value;
}

module.exports = {
  col,
  insertWithId,
  withTransaction,
};
