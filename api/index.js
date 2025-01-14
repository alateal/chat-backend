const express = require('express');
const router = express.Router();
const usersRouter = require('./users');
const conversationsRouter = require('./conversations');
const messagesRouter = require('./messages');
const searchRouter = require('./search');
const filesRouter = require('./file');

module.exports = function () {

    router.use('/users', usersRouter());
    router.use('/conversations', conversationsRouter());
    router.use('/messages', messagesRouter());
    router.use('/search', searchRouter());
    router.use('/files', filesRouter());

    return router;
  };