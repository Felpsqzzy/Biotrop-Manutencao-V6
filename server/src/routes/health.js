const express = require('express');
const { pool } = require('../db/pool');
const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
