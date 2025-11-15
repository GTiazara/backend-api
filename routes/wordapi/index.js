const express = require('express');
const { connectToDb } = require('../../db/connect');

const router = express.Router();
let collectionPromise = null;

async function getCollection() {
  // Only initialize once
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const validationObject = require('../../db/validators/word_class.json');
      const { collection } = await connectToDb('worddb', 'word_class', { validatorObject: validationObject });

      // Ensure unique index
      try {
        await collection.createIndex({ categoryName: 1 }, { unique: true });
      } catch (err) {
        console.warn('Could not create unique index:', err.message);
      }

      console.log('Connected to worddb -> word_class collection');
      return collection;
    })();
  }

  return collectionPromise;
}

// GET /categories
router.get('/categories', async (req, res) => {
  let collection;
  try {
    collection = await getCollection();
  } catch (err) {
    return res.status(503).json({ error: 'DB not ready' });
  }

  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit < 1 || limit > 1000) limit = 100;

  try {
    const now = new Date();
    const count = await collection.countDocuments();
    const latest = await collection.find({}).sort({ createdAt: -1 }).limit(1).toArray();
    const lastCreatedAt = latest[0]?.createdAt || null;
    const oneDayMs = 24*60*60*1000;

    if (count > 1000) {
      const toRemove = await collection.aggregate([{ $sample: { size: 100 } }, { $project: { _id: 1 } }]).toArray();
      if (toRemove.length) await collection.deleteMany({ _id: { $in: toRemove.map(d => d._id) } });
      const newCats = await generateCategories(100);
      await collection.insertMany(newCats, { ordered: false }).catch(e => console.warn('Insert after prune errors:', e.message));
    }

    if (!lastCreatedAt || (now - new Date(lastCreatedAt) >= oneDayMs)) {
      const newCats = await generateCategories(100);
      await collection.insertMany(newCats, { ordered: false }).catch(e => console.warn('Insert errors:', e.message));
    }

    const docs = await collection.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
    res.json(docs);
  } catch (err) {
    console.error('GET /categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /categories
router.post('/categories', express.json(), async (req, res) => {
  let collection;
  try {
    collection = await getCollection();
  } catch (err) {
    return res.status(503).json({ error: 'DB not ready' });
  }

  const { categoryName, words } = req.body || {};
  if (!categoryName || !Array.isArray(words) || words.length < 1 || words.length > 20 || !words.every(w => typeof w === 'string')) {
    return res.status(400).json({ error: 'Invalid categoryName or words array' });
  }

  try {
    const result = await collection.insertOne({ categoryName, words, createdAt: new Date() });
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'categoryName already exists' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
