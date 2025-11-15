const express = require('express');
const { connectToDb } = require('../../db/connect');

const router = express.Router();

// Lazy DB initialization
let collectionPromise = null;
async function getCollection() {
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

// ----- AI Category Generation -----
function fallbackGenerate(n) {
  const adjectives = ['blue','green','golden','ancient','modern','silent','loud','quick','slow','bright','dark','tiny','giant'];
  const nouns = ['garden','river','market','song','journey','castle','cafe','street','plate','device','machine','festival','language','flavor'];
  const wordsPool = ['apple','stone','river','cloud','light','sound','dance','wind','fire','earth','ocean','mountain','bird','leaf','root','spark','tone','glass','bridge','path','seed','pulse','orbit','note','frame'];

  const out = [];
  for (let i = 0; i < n; i++) {
    const catName = `${adjectives[i % adjectives.length]} ${nouns[i % nouns.length]} ${Math.floor(Math.random()*10000)}`;
    const words = [];
    const wordsCount = 5 + (i % 16);
    for (let j = 0; j < wordsCount; j++) {
      words.push(wordsPool[Math.floor(Math.random() * wordsPool.length)] + (Math.random()<0.1?`_${Math.floor(Math.random()*100)}`:''));
    }
    out.push({ categoryName: catName, words: Array.from(new Set(words)).slice(0,20), createdAt: new Date(), ai: 'No-ai-fallback' });
  }
  return out;
}

async function generateCategories(n) {
  // Gemini (Google)
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (GEMINI_API_KEY) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
      const prompt = `Génère ${n} éléments JSON en français, chacun avec "categoryName" et "words" (5-20 mots uniques). Retourne uniquement un tableau JSON.`;
      const response = await model.generateContent(prompt);
      const text = response?.response?.text?.();
      if (text) {
        const jsonMatch = text.match(/```json([\s\S]*?)```/) || text.match(/(\[\s*\{[\s\S]*\}\s*\])/);
        const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;
        const parsed = JSON.parse(jsonText);
        return parsed.map(p => ({ categoryName: String(p.categoryName), words: (p.words||[]).slice(0,20).map(String), createdAt: new Date(), ai: 'gemini' }) );
      }
    } catch (e) {
      console.warn('Gemini generation failed:', e.message || e);
    }
  }

  // Mistral
  const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
  if (MISTRAL_API_KEY) {
    try {
      const { Mistral } = require('@mistralai/mistralai');
      const client = new Mistral({ apiKey: MISTRAL_API_KEY });
      const prompt = `Retourne ${n} éléments JSON avec categoryName et words (5-20 mots uniques).`;
      const resp = await client.chat.complete({ model: 'mistral-large-latest', messages: [{ role: 'user', content: prompt }] });
      const text = resp?.choices?.[0]?.message?.content;
      if (text) {
        const jsonMatch = text.match(/```json([\s\S]*?)```/) || text.match(/(\[\s*\{[\s\S]*\}\s*\])/);
        const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;
        const parsed = JSON.parse(jsonText);
        return parsed.map(p => ({ categoryName: String(p.categoryName), words: (p.words||[]).slice(0,20).map(String), createdAt: new Date(), ai: 'mistral' }) );
      }
    } catch (e) {
      console.warn('Mistral generation failed:', e.message || e);
    }
  }

  // Fallback
  return fallbackGenerate(n);
}

// ----- ROUTES -----
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

    // Prune and add if over 1000
    if (count > 1000) {
      const toRemove = await collection.aggregate([{ $sample: { size: 100 } }, { $project: { _id: 1 } }]).toArray();
      if (toRemove.length) await collection.deleteMany({ _id: { $in: toRemove.map(d => d._id) } });
      const newCats = await generateCategories(100);
      await collection.insertMany(newCats, { ordered: false }).catch(e => console.warn('Insert after prune errors:', e.message));
    }

    // Add if empty or >1 day since last
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
