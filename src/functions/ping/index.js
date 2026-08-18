module.exports = async function (context) {
  context.res = { status: 200, body: { ok: true, time: new Date().toISOString() } };
};
