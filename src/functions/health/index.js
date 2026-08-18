'use strict';
module.exports = async function (context) {
  context.res = {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      status: 'ok',
      timestamp: new Date().toISOString(),
    },
  };
};
