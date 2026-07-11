'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const mongoSanitize = require('../src/middleware/mongoSanitize');
const { _strip } = mongoSanitize;

describe('mongoSanitize._strip', () => {
  it('removes top-level $-prefixed keys, keeps the rest', () => {
    const out = _strip({ email: 'a@b.co', $ne: null, $gt: 1 });
    assert.deepEqual(out, { email: 'a@b.co' });
  });

  it('removes $-keys nested in objects and arrays', () => {
    const out = _strip({ user: { name: 'x', $where: 'evil' }, list: [{ ok: 1, $ne: 2 }] });
    assert.deepEqual(out, { user: { name: 'x' }, list: [{ ok: 1 }] });
  });

  it('strips prototype-pollution keys', () => {
    const obj = JSON.parse('{"a":1,"__proto__":{"admin":true},"constructor":2,"prototype":3}');
    const out = _strip(obj);
    assert.deepEqual(Object.keys(out), ['a']);
  });

  it('never touches values (only keys) — an operator-looking string is fine', () => {
    const out = _strip({ note: '$100 off, price > $50' });
    assert.deepEqual(out, { note: '$100 off, price > $50' });
  });

  it('strips a $-key at deep nesting (no depth gap)', () => {
    let deep = { email: { $ne: null } }; // the payload we must catch, buried deep
    for (let i = 0; i < 200; i++) deep = { nested: deep };
    _strip(deep);
    // walk to the bottom and confirm $ne is gone
    let cur = deep;
    while (cur.nested) cur = cur.nested;
    assert.deepEqual(cur, { email: {} });
  });

  it('does not throw or hang on a cyclic object', () => {
    const a = { name: 'x', $bad: 1 };
    a.self = a; // cycle
    assert.doesNotThrow(() => _strip(a));
    assert.equal(a.$bad, undefined);
  });
});

describe('mongoSanitize middleware (integration over real HTTP)', () => {
  let server, base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(mongoSanitize);
    app.all('/echo', (req, res) => res.json({ body: req.body, query: req.query }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server && server.close());

  const req = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  it('strips operator keys from the JSON body, keeps legit fields', async () => {
    const out = await req('POST', '/echo', { email: { $ne: null }, name: 'ok' });
    assert.deepEqual(out.body, { email: {}, name: 'ok' });
  });

  it('strips operator keys from the query string (Express getter case)', async () => {
    const out = await req('GET', '/echo?a[$gt]=1&b=2&c[$ne]=x');
    // $gt/$ne keys gone; b survives; a/c become empty objects (their only key was an operator)
    assert.equal(out.query.b, '2');
    assert.deepEqual(out.query.a, {});
    assert.deepEqual(out.query.c, {});
  });

  it('leaves clean requests untouched', async () => {
    const out = await req('POST', '/echo?page=2', { title: 'Hello', tags: ['a', 'b'] });
    assert.deepEqual(out.body, { title: 'Hello', tags: ['a', 'b'] });
    assert.equal(out.query.page, '2');
  });
});
