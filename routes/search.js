const express = require('express');
const router = express.Router();
const { searchEvents } = require('../controllers/searchEvents');


router.get('/search', searchEvents);



module.exports = router;
