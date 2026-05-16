const express = require('express');
const { collections, nextSequence } = require('../db');
const { deriveAddresses } = require('../wallet');

const router = express.Router();

// POST /v1/users — create or get a user
// body: { user_id: string }
router.post('/v1/users', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'invalid_user_id', message: 'user_id is required' });
    }

    // Idempotent: if the user already exists, return them
    const existing = await collections.users.findOne({ user_id });
    if (existing) {
      return res.json({
        user_id: existing.user_id,
        tron_address: existing.tron_address,
        bsc_address: existing.bsc_address,
        created_at: existing.created_at,
      });
    }

    const index = await nextSequence('user_index');
    const { tron_address, bsc_address } = deriveAddresses(index);

    await collections.users.insertOne({
      user_id,
      derivation_index: index,
      tron_address,
      bsc_address,
      pending_payment_count: 0,
      unconfirmed_deposit_count: 0,
      tron_last_block_timestamp: 0,
      bsc_last_block: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });

    res.status(201).json({
      user_id,
      tron_address,
      bsc_address,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('create user error:', err.message);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /v1/users/:user_id
router.get('/v1/users/:user_id', async (req, res) => {
  try {
    const user = await collections.users.findOne({ user_id: req.params.user_id });
    if (!user) return res.status(404).json({ error: 'not_found' });
    res.json({
      user_id: user.user_id,
      tron_address: user.tron_address,
      bsc_address: user.bsc_address,
      created_at: user.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

module.exports = router;