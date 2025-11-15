const express = require('express');
const path = require('path');
const { connectToDb } = require('../../db/connect');

const router = express.Router();

// Module-level collection handle; routes will return 503 if not ready.
let collection = null;

// Attempt to connect and ensure collection exists. Do not throw on failure — just log.
(async () => {
  try {
    validationObject = require('../../db/validators/word_class.json')
    const { db, collection: coll } = await connectToDb('worddb', 'word_class', { validationObject: validationObject });

    collection = coll;

    // Ensure an index on categoryName for quick lookup and uniqueness
    try {
      await collection.createIndex({ categoryName: 1 }, { unique: true });
    } catch (idxErr) {
      // Index creation might fail if collection already has duplicates; log and continue
      console.warn('Could not create unique index on categoryName:', idxErr.message);
    }

    console.log('wordapi: connected to worddb and ensured word_class collection');
  } catch (err) {
    console.warn('wordapi: could not connect/create collection (continuing without DB):', err.message);
  }
})();

// GET /wordapi/categories - list all categories
router.get('/categories', async (req, res) => {
  if (!collection) return res.status(503).json({ error: 'DB not ready' });
  try {
    const now = new Date();

    // Count documents and get latest createdAt
    const count = await collection.countDocuments();
    const latest = await collection.find({}).sort({ createdAt: -1 }).limit(1).toArray();
    const lastCreatedAt = latest[0] ? latest[0].createdAt : null;

    const oneDayMs = 24 * 60 * 60 * 1000;

    // Helper: fallback category generator (no external AI)
    function fallbackGenerate(n) {
      const adjectives = ['blue','green','golden','ancient','modern','silent','loud','quick','slow','bright','dark','tiny','giant'];
      const nouns = ['garden','river','market','song','journey','castle','cafe','street','plate','song','device','machine','festival','language','flavor'];
      const wordsPool = ['apple','stone','river','cloud','light','sound','dance','wind','fire','earth','ocean','mountain','bird','leaf','root','spark','tone','glass','bridge','path','seed','pulse','orbit','note','frame'];

    const out = [];
    for (let i = 0; i < n; i++) {
      const catName = `${adjectives[i % adjectives.length]} ${nouns[i % nouns.length]} ${Math.floor(Math.random()*10000)}`;
      const words = [];
      const wordsCount = 5 + (i % 16); // between 5 and 20
      for (let j = 0; j < wordsCount; j++) {
        words.push(wordsPool[Math.floor(Math.random() * wordsPool.length)] + (Math.random()<0.1?`_${Math.floor(Math.random()*100)}`:''));
      }
      out.push({ categoryName: catName, words: Array.from(new Set(words)).slice(0,20), createdAt: new Date(), ai: 'No-ai-fallback' });
    }
    return out;
    }

    // Try to generate `n` categories using available AI providers; fall back when not available.
    async function generateCategories(n) {
      // Try Gemini (Google Generative AI)
      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (GEMINI_API_KEY) {
        try {
          const { GoogleGenerativeAI } = require('@google/generative-ai');
          const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

          const prompt = `Génère ${n} éléments JSON en français, chacun étant un objet avec les clés "categoryName" (titre court) et "words" (un tableau de 5 à 20 mots courts en un seul mot). Retourne uniquement un tableau JSON. Exemple: [{"categoryName":"x","words":["a","b"]}, ...]. Assure-toi que les mots sont uniques par catégorie.`;

          const response = await model.generateContent(prompt);
          const text = response?.response?.text?.();
          if (text) {
            // Extract JSON from backticks or plain JSON
            const jsonMatch = text.match(/```json([\s\S]*?)```/) || text.match(/(\[\s*\{[\s\S]*\}\s*\])/);
            const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;
            const parsed = JSON.parse(jsonText);
            // Normalize to expected shape and attach createdAt
            return parsed.map(p => ({ categoryName: String(p.categoryName), words: (p.words||[]).slice(0,20).map(String), createdAt: new Date(), ai: 'gemini' }) );
          }
        } catch (e) {
          console.warn('Gemini generation failed:', e.message || e);
        }
      }

      // Try Mistral
      const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
      if (MISTRAL_API_KEY) {
        try {
          const { Mistral } = require('@mistralai/mistralai');
          const client = new Mistral({ apiKey: MISTRAL_API_KEY });
          const prompt = `Retourne ${n} éléments en français sous forme d'un tableau JSON. Chaque élément doit avoir categoryName (chaîne) et words (tableau de 5 à 20 mots uniques, mots simples). Retourne uniquement le JSON.`;
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

    // If collection has >1000 categories, remove random 100 then add 100 new
    if (count > 1000) {
      const toRemove = await collection.aggregate([{ $sample: { size: 100 } }, { $project: { _id: 1 } }]).toArray();
      const idsToRemove = toRemove.map(d => d._id);
      if (idsToRemove.length) {
        await collection.deleteMany({ _id: { $in: idsToRemove } });
      }
      const newCats = await generateCategories(100);
      try {
        await collection.insertMany(newCats, { ordered: false });
      } catch (e) {
        console.warn('Insert many (after prune) had errors:', e.message || e);
      }
    }

    // If last created less than 1 day ago, skip generation
    if (lastCreatedAt && (now - new Date(lastCreatedAt) < oneDayMs)) {
      // Do nothing generation-wise
    } else {
      // If empty, or simply not recently updated, add 100 categories
      if (count === 0 || !lastCreatedAt || (now - new Date(lastCreatedAt) >= oneDayMs)) {
        const newCats = await generateCategories(100);
        try {
          await collection.insertMany(newCats, { ordered: false });
        } catch (e) {
          // ignore duplicate-key or partial errors
          console.warn('Insert many had errors:', e.message || e);
        }
      }
    }

    // Finally return categories (limit to 1000 for response safety)
    const docs = await collection.find({}).sort({ createdAt: -1 }).limit(1000).toArray();
    res.json(docs);
  } catch (err) {
    console.error('GET /categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /wordapi/categories - create a new category
// body: { categoryName: string, words: [string] }
router.post('/categories', express.json(), async (req, res) => {
  if (!collection) return res.status(503).json({ error: 'DB not ready' });

  const { categoryName, words } = req.body || {};
  if (!categoryName || !Array.isArray(words)) {
    return res.status(400).json({ error: 'categoryName (string) and words (array) are required' });
  }
  if (words.length < 1 || words.length > 20) {
    return res.status(400).json({ error: 'words must contain between 1 and 20 items' });
  }
  if (!words.every(w => typeof w === 'string')) return res.status(400).json({ error: 'all words must be strings' });

  try {
    const now = new Date();
    const doc = { categoryName, words, createdAt: now };
    const result = await collection.insertOne(doc);
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    // Duplicate key -> category already exists
    if (err.code === 11000) return res.status(409).json({ error: 'categoryName already exists' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
