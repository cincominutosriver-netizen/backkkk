const express = require('express');
const router = express.Router();
const { getEventById } = require('../controllers/getEventById');

router.get('/:id', getEventById);

module.exports = router;
