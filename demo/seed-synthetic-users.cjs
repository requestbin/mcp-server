/**
 * LOCAL REVIEW-DB ONLY. Inserts four synthetic, test-owned users (free, free2, pro, other-free) with fresh random API
 * keys, tagged `cx20261014`, and writes the raw keys to a 0600 file (never printed). No Clerk account is created.
 * `--cleanup` deletes ONLY users with that tag and the mock endpoints they own. Never touches any other document.
 *
 *   MONGODB_URI=mongodb://localhost:27017 MONGODB_DB=requestbin_phase0_review KEYS_FILE=/path/keys.env \
 *     node demo/seed-synthetic-users.cjs [--cleanup]
 * Needs the `mongodb` package (resolve it from the SaaS repo: NODE_PATH=../requestbin.saas/node_modules).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const { MongoClient } = require('mongodb');

const TAG = 'cx20261014';
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB = process.env.MONGODB_DB || 'requestbin_phase0_review';
const KEYS_FILE = process.env.KEYS_FILE;
const USERS = [{ n: 'free', plan: 'free' }, { n: 'free2', plan: 'free' }, { n: 'pro', plan: 'pro' }, { n: 'other', plan: 'free' }, { n: 'llm', plan: 'free' }];
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null; // seed just these (appends to KEYS_FILE)

(async () => {
  const c = new MongoClient(URI);
  await c.connect();
  const db = c.db(DB);
  const users = db.collection('users');
  if (process.argv.includes('--cleanup')) {
    const mine = await users.find({ clerkId: { $regex: `^${TAG}_` } }).toArray();
    const ids = mine.map(u => u.userId);
    const eps = await db.collection('mockendpoints').deleteMany({ userId: { $in: ids } });
    const del = await users.deleteMany({ clerkId: { $regex: `^${TAG}_` } });
    console.log(JSON.stringify({ deletedUsers: del.deletedCount, deletedEndpoints: eps.deletedCount, note: 'captures of deleted endpoints are left to normal retention' }));
    await c.close();
    return;
  }
  const lines = [];
  for (const u of USERS.filter(x => !ONLY || ONLY.includes(x.n))) {
    const raw = `rb_${TAG}_${crypto.randomBytes(18).toString('hex')}`;
    const userId = `${TAG}-${u.n}`;
    await users.insertOne({
      clerkId: `${TAG}_${u.n}`, userId, email: `${TAG}-${u.n}@example.invalid`, name: `synthetic ${u.n}`, plan: u.plan,
      apiKeys: [{ keyId: crypto.randomUUID(), keyHash: crypto.createHash('sha256').update(raw).digest('hex'), name: 'cx20261014 demo', prefix: raw.slice(0, 10), createdAt: new Date() }],
      createdAt: new Date(), updatedAt: new Date(),
    });
    lines.push(`RB_KEY_${u.n.toUpperCase()}=${raw}`);
  }
  fs.writeFileSync(KEYS_FILE, `${lines.join('\n')}\n`, { mode: 0o600, flag: ONLY ? 'a' : 'w' });
  console.log(JSON.stringify({ seeded: USERS.filter(x => !ONLY || ONLY.includes(x.n)).map(u => `${TAG}-${u.n}`), keysFile: KEYS_FILE, keysPrinted: false }));
  await c.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
